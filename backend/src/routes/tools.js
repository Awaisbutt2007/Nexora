import { Router } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { publicModelLabel } from '../config.js'
import { getDb, nowIso } from '../db/index.js'
import { requireAuth, sanitizeUser } from '../middleware/auth.js'
import { aiLimiter } from '../middleware/rateLimit.js'
import { deductCredits, ensureCredits } from '../services/credits.js'
import { enrichImagePrompt, imageProxyPath, isNsfwPrompt } from '../services/images.js'
import { completeChat } from '../services/ai.js'

const router = Router()
router.use(requireAuth)

export const TOOL_CATALOG = [
  {
    id: 'image_generator',
    name: 'Image Generator',
    description: 'Create striking images from a simple prompt.',
    creditCost: 20,
  },
  {
    id: 'code_assistant',
    name: 'Code Assistant',
    description: 'Write, debug, and explain code with context.',
    creditCost: 5,
  },
  {
    /* Ids stay stable for saved runs; names say what the tool really does — it reads
       text the user pastes, it does not open PDF files or fetch videos. */
    id: 'pdf_reader',
    name: 'Document Q&A',
    description: 'Paste document text, then ask questions about it.',
    creditCost: 8,
  },
  {
    id: 'youtube_notes',
    name: 'Video Notes',
    description: 'Paste a video transcript and get clear takeaways.',
    creditCost: 10,
  },
  {
    id: 'meeting_notes',
    name: 'Meeting Notes',
    description: 'Capture decisions and next steps automatically.',
    creditCost: 8,
  },
  {
    id: 'social_studio',
    name: 'Social Studio',
    description: 'Shape one idea into content for every channel.',
    creditCost: 6,
  },
]

router.get('/', (_req, res) => {
  res.json({ object: 'list', data: TOOL_CATALOG })
})

router.get('/runs', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT id, tool, input_json AS input, output_json AS output, status,
              created_at AS createdAt, completed_at AS completedAt
       FROM tool_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .all(req.user.id)
    .map((r) => ({
      ...r,
      input: safeJson(r.input),
      output: safeJson(r.output),
    }))

  res.json({ object: 'list', data: rows })
})

router.post('/:toolId/run', aiLimiter, async (req, res, next) => {
  try {
    const tool = TOOL_CATALOG.find((t) => t.id === req.params.toolId)
    if (!tool) {
      return res.status(404).json({ error: { message: 'Unknown tool', type: 'not_found' } })
    }

    const schema = z.object({
      prompt: z.string().trim().max(8000).optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      assistantName: z.string().trim().max(40).optional(),
      persona: z.string().trim().max(400).optional(),
    })
    const body = schema.parse(req.body || {})
    const payload = {
      prompt: body.prompt || '',
      ...(body.input || {}),
    }

    ensureCredits(req.user, tool.creditCost)

    const id = `run_${nanoid(16)}`
    const stamp = nowIso()
    const output = await buildToolOutput(tool, payload, {
      assistantName: body.assistantName,
      userName: req.user.name,
      persona: body.persona,
    })

    getDb()
      .prepare(
        `INSERT INTO tool_runs (id, user_id, tool, input_json, output_json, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
      )
      .run(id, req.user.id, tool.id, JSON.stringify(payload), JSON.stringify(output), stamp, stamp)

    const updated = deductCredits(req.user.id, tool.creditCost)

    res.status(201).json({
      id,
      tool: tool.id,
      status: 'completed',
      output,
      /* Premium plans are unlimited — report what was actually taken. */
      creditsCharged: req.user.isPremium ? 0 : tool.creditCost,
      user: sanitizeUser(updated),
      createdAt: stamp,
      completedAt: stamp,
    })
  } catch (err) {
    next(err)
  }
})

function safeJson(value) {
  if (value == null) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/* Each text tool is a focused instruction that turns the user's pasted prompt
   into a real model run (via completeChat) instead of a canned placeholder. In
   mock mode it still streams the honest mock reply; with a key set it is the
   live model. The answer is returned as markdown and rendered on the client by
   the same parser the chat uses (code fences → copy button, images → lightbox). */
const TOOL_BRIEF = {
  code_assistant: 'You are the Nexora Code Assistant. Write complete, correct, ready-to-run code for the request. Put the full solution inside one fenced code block tagged with the language, then add a short explanation. Do not leave TODO placeholders or empty stub bodies.',
  pdf_reader: 'You are the Nexora Document Q&A tool. If the user pasted document text, summarize it and answer their questions with short supporting quotes. If they only gave a title or a question with no text, ask them to paste the document text — Nexora does not fetch files on its own.',
  youtube_notes: 'You are the Nexora Notes tool. Turn the transcript or topic the user pastes into concise takeaways: a two-line summary, key points as bullets, and suggested action items. If no content was pasted, ask for the transcript or notes.',
  meeting_notes: 'You are the Nexora Meeting Notes tool. From the raw notes the user pastes, produce Decisions, Action Items (owner + task) and Open Questions. If nothing was pasted, ask for the raw notes.',
  social_studio: "You are the Nexora Social Studio. Rewrite the user's idea into polished, platform-native copy for X/Twitter, LinkedIn and Instagram, each under its own bold heading, ready to post.",
}

async function buildToolOutput(tool, payload, ctx) {
  const prompt = payload.prompt || JSON.stringify(payload)

  if (tool.id === 'image_generator') {
    return isNsfwPrompt(prompt)
      ? {
          type: 'image',
          prompt,
          imageUrl: null,
          blocked: true,
          note: 'Adult/NSFW content is not allowed on Nexora. Try a different, safe prompt.',
        }
      : {
          type: 'image',
          prompt,
          /* Same portrait-default guard as the chat path: a thin one-word prompt
             ("coding") makes Flux draw a person. Long prompts are the user's own
             careful wording, so enrichImagePrompt passes them through untouched. */
          imageUrl: imageProxyPath(enrichImagePrompt(prompt)),
          /* The answer to "how is this made?" stays off the wire — including in our own
             friendly captions. Which service renders a picture is operator information. */
          note: 'Rendered by Nexora’s built-in image engine. If a generator key is added on the server, limits and reliability go up.',
        }
  }

  const brief = TOOL_BRIEF[tool.id]
  if (!brief) return { type: 'text', prompt, answer: prompt }

  const content = `${brief}\n\nUser request:\n${prompt || '(nothing provided yet)'}`
  const result = await completeChat({
    history: [{ role: 'user', content }],
    assistantName: ctx.assistantName,
    userName: ctx.userName,
    persona: ctx.persona,
    channel: 'tool',
  })
  return { type: 'text', prompt, answer: result.content, model: publicModelLabel(result.model) }
}

export default router
