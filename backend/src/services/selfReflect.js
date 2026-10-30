import { nanoid } from 'nanoid'
import { config } from '../config.js'
import { nowIso } from '../db/index.js'
import { completeChat } from './ai.js'

/* ────────────────────────────────────────────────────────────────────────────
   SELF-REFLECTION — the companion learns from the real exchange without being
   told to. After a reply lands, this pass reads the conversation that just
   happened, asks the model to distil at most a couple of DURABLE things worth
   remembering about this user (preferences, topics they love, how they like
   answers), and writes them into the SAME memories table the "remember …"
   feature uses. Because those memories are already injected into every future
   reply as "Known user context", the improvement is realised with zero extra
   wiring — she simply gets better over time, on its own.

   It is deliberately cheap and invisible:
   - best-effort: any failure is swallowed, it must NEVER block or fail a reply;
   - throttled: runs only on every Nth message of a thread, so it does not double
     the daily token spend on the tight free-tier budget (see services/ai.js);
   - privacy-first: the prompt forbids secrets/sensitive categories and any
     mention of the engine, and every memory is saved with source='assistant' so
     the user sees exactly what she learned in the Memory Vault and can delete it.
   ──────────────────────────────────────────────────────────────────────────── */

const REFLECT_EVERY = 6 // run once every N messages in a thread (user+assistant rows)
const MAX_RUN_MEMORIES = 2 // hard cap on memories written per pass
const MAX_ASSISTANT_MEMORIES = 12 // total reflection-owned memories we keep per user
const VALUE_MAX = 220
const TRANSCRIPT_WINDOW = REFLECT_EVERY * 2 // only reflect on the recent slice
const LINE_MAX = 600

function reflectionSystem(assistantName) {
  return [
    'You are the private self-improvement pass for a personal AI companion. You are NOT replying to the user; you are silently reflecting on a conversation that already happened so that FUTURE replies can be better.',
    /* The companion now ships with a seeded set of favourites (services/taste.js), and
     * the prompt tells her a saved memory outranks it — which is only true if a taste
     * the USER assigns to her actually gets saved. The old line read "about the user",
     * so "tumhara favourite colour ab green hai" was durable information and got dropped. */
    'Read the exchange and the current memory list. Extract at most 2 durable, genuinely useful things: stable facts or preferences about the user, a taste the user explicitly assigns to the companion herself/himself (key it assistant_taste_colour, assistant_taste_song, … — that overrides her seeded favourite from then on), or concrete ways the companion should adapt to THIS user (tone they respond to, topics they keep returning to, the kind of answer length/style they asked for).',
    'Strict rules: only what is stable and clearly useful later; never guess; never store one-off chat content; NEVER store secrets or sensitive categories (health diagnoses, religion, political views, sexual life, financial account details, government ID numbers, passwords); NEVER mention the model, provider, API, prompts or any internal workings.',
    'Do not duplicate or contradict an existing memory. If you are refining one, reuse its exact key; otherwise prefer a fresh short key.',
    'Respond with ONLY a JSON object and nothing else: { "memories": [ { "key": "<short slug, max 8 words>", "value": "<one concise sentence>" } ] }. Use an empty array when there is nothing durable to save.',
    assistantName
      ? `Write each value in the language the user has mostly been writing in; when unsure, use English.`
      : `Write each value in English.`,
  ].join('\n')
}

/* The model occasionally wraps its JSON in a ``` fence; take the outermost object
   so a stray code fence never loses the learnings. Same tolerance as the planner. */
function parseJson(text) {
  if (!text) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const raw = (fence ? fence[1] : text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function transcribe(rows) {
  const who = (r) => (r.role === 'user' ? 'User' : 'Companion')
  return rows
    .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.content)
    .map((r) => `${who(r)}: ${String(r.content).replace(/\s+/g, ' ').slice(0, LINE_MAX)}`)
    .join('\n')
}

/* Returns a small status object; the caller fire-and-forgets and ignores it. */
export async function maybeReflectOnConversation({ db, userId, conversationId, assistantName, userName, gender }) {
  if (!config.openaiApiKey) return { skipped: 'mock' }

  const rows = db
    .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId)

  // Throttle: only when the thread just crossed a multiple of REFLECT_EVERY.
  if (!rows.length || rows.length % REFLECT_EVERY !== 0) return { skipped: 'throttle' }
  // Need a real back-and-forth to reflect on, not a one-sided stub.
  if (!rows.some((r) => r.role === 'user') || !rows.some((r) => r.role === 'assistant')) return { skipped: 'thin' }

  const transcript = transcribe(rows.slice(-TRANSCRIPT_WINDOW))
  if (transcript.length < 20) return { skipped: 'empty' }

  const memories = db
    .prepare(`SELECT key, value FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20`)
    .all(userId)

  let result
  try {
    result = await completeChat({
      history: [
        { role: 'system', content: reflectionSystem(assistantName) },
        {
          role: 'user',
          content: `Conversation:\n${transcript}\n\nCurrent memories:\n${memories.map((m) => `- ${m.key}: ${m.value}`).join('\n') || '(none)'}`,
        },
      ],
      memories,
      assistantName,
      userName,
      gender,
      // no `language`: this must stay a literal JSON translator, not a stylistic persona
    })
  } catch {
    // a rate limit / provider error here is invisible to the user — skip this pass
    return { skipped: 'model_error' }
  }

  const parsed = parseJson(result?.content)
  const list = Array.isArray(parsed?.memories) ? parsed.memories.slice(0, MAX_RUN_MEMORIES) : []
  const stamp = nowIso()
  const saved = []

  for (const item of list) {
    const value = String(item?.value || '').trim().slice(0, VALUE_MAX)
    if (value.length < 4) continue
    const key =
      String(item?.key || '').trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 60) ||
      value.split(/\s+/).slice(0, 5).join(' ').slice(0, 60) ||
      'insight'
    const existing = db.prepare('SELECT id FROM memories WHERE user_id = ? AND key = ?').get(userId, key)
    if (existing) {
      db.prepare('UPDATE memories SET value = ?, source = ?, updated_at = ? WHERE id = ?').run(value, 'assistant', stamp, existing.id)
      saved.push(existing.id)
      continue
    }
    const id = `mem_${nanoid(16)}`
    db.prepare(
      `INSERT INTO memories (id, user_id, key, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'assistant', ?, ?)`,
    ).run(id, userId, key, value, stamp, stamp)
    saved.push(id)
  }

  /* Bound reflection's footprint so its (fresher) rows can never crowd the user's
     own "remember …" facts out of the recency-capped context window: prune our
     oldest assistant memories down to the cap. User-source rows are never touched. */
  if (saved.length) {
    const keep = db
      .prepare(`SELECT id FROM memories WHERE user_id = ? AND source = 'assistant' ORDER BY updated_at DESC LIMIT -1 OFFSET ?`)
      .all(userId, MAX_ASSISTANT_MEMORIES)
    for (const row of keep) db.prepare('DELETE FROM memories WHERE id = ?').run(row.id)
  }

  return { saved: saved.length }
}

export { REFLECT_EVERY, MAX_RUN_MEMORIES, MAX_ASSISTANT_MEMORIES, parseJson, transcribe }
