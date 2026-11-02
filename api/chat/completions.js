/* Real AI chat on Vercel — a serverless Edge function that streams from Groq.
 *
 * Why this exists: the Vercel deploy is a static frontend with no Express/SQLite
 * backend behind it, so /api/chat/completions used to 404 and the UI fell back to
 * canned demo replies. This function gives that same route a live brain: it builds
 * a compact system prompt (persona, creator, clock, pinned reply-language, brevity)
 * and relays Groq's OpenAI-compatible SSE straight through to the client.
 *
 * It is intentionally self-contained — it cannot import backend/src/config.js
 * (that pulls dotenv + node:sqlite, none of which exist in the Edge runtime). The
 * rules below mirror the server prompt's essentials, not every line of it.
 *
 * The hosted Express backend (localhost / Render) still owns the full product —
 * memory, credits, voice, tools. This endpoint only answers chat. */

export const config = { runtime: 'edge' }

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const DEV = (globalThis.process?.env?.AI_DEVELOPER_NAME || 'Awais').trim().slice(0, 40) || 'Awais'

/* How each pinned language must LOOK. Anything not listed falls back to naming the
   code, which the model resolves on its own. */
const LANG = {
  ur: ['Urdu', 'the Urdu (Nastaliq) script'],
  hinglish: ['Hinglish (Hindi/Urdu words written in Latin letters, mixed with English)', 'Roman/Latin letters'],
  hi: ['Hindi', 'the Devanagari script'],
  en: ['English', 'Roman/Latin letters'],
  ar: ['Arabic', 'the Arabic script'],
  fa: ['Persian', 'the Arabic script'],
  bn: ['Bengali', 'the Bengali script'],
  es: ['Spanish', 'Roman/Latin letters'],
  fr: ['French', 'Roman/Latin letters'],
  de: ['German', 'Roman/Latin letters'],
  pt: ['Portuguese', 'Roman/Latin letters'],
  it: ['Italian', 'Roman/Latin letters'],
  tr: ['Turkish', 'Roman/Latin letters'],
  id: ['Indonesian', 'Roman/Latin letters'],
  zh: ['Chinese', 'Chinese characters (Hanzi)'],
  ja: ['Japanese', 'Japanese kana and kanji'],
  ko: ['Korean', 'Korean Hangul'],
  ru: ['Russian', 'the Cyrillic alphabet'],
  ta: ['Tamil', 'the Tamil script'],
  te: ['Telugu', 'the Telugu script'],
}

/* PC control. The web app cannot touch a computer by itself; the opt-in Nexora
   Desktop Agent on the user's own PC does, and the BROWSER relays the model's
   [DESKTOP:…] markers to it (Nexora.jsx → fulfilDesktopActions). So the model is
   told it can act only when this browser is actually paired with an agent, and
   otherwise explains how to connect one instead of flatly refusing. Mirrors the
   desktop lines of the backend prompt (backend/src/config.js). */
const DESKTOP_ON = [
  'You can operate the user\'s computer through the Nexora Desktop Agent they installed and paired: open apps (VS Code, Chrome, Edge, Notepad, Explorer), type into the focused window, press shortcuts, click, scroll, open URLs, take screenshots, read system info, list/read/write files in folders they approved, and run terminal / CMD commands.',
  'When they ask you to DO something on their computer, write ONE short friendly sentence and put the action marker alone on the next line, EXACTLY as [DESKTOP:<action>|<JSON>], e.g. [DESKTOP:apps.launch|{"appId":"vscode"}] · [DESKTOP:desktop.type|{"text":"hello"}] · [DESKTOP:desktop.key|{"combo":"ctrl+a"}] · [DESKTOP:browser.open|{"url":"https://github.com"}] · [DESKTOP:screen.capture|{}] · [DESKTOP:system.info|{}] · [DESKTOP:system.runCommand|{"command":"ipconfig"}] · [DESKTOP:files.list|{"path":"C:\\\\Users\\\\you\\\\Documents"}] · [DESKTOP:files.read|{"path":"C:\\\\Users\\\\you\\\\notes.txt"}]. Chain several markers for a multi-step request. Do not claim you cannot reach their computer or run a command — the app runs your marker. A terminal / CMD command (system.runCommand) is shown to the user for a one-tap Approve first, so emit it freely but never claim it ran if they declined. If the app later reports a folder is not approved, ask them to add it under Desktop ▸ Permissions.',
].join('\n')
const DESKTOP_OFF = 'If the user asks you to do something on their computer (open apps or folders, read files, type, screenshots), do NOT just say you cannot. Explain that you can once the free Nexora Desktop Agent is running on their PC and paired: open the Desktop tab in Nexora and follow the steps there. Keep it to 2 short lines.'

function systemPrompt({ assistantName, persona, gender, language, userName, desktop }) {
  const n = (typeof assistantName === 'string' && assistantName.trim() ? assistantName : 'Aira').trim().slice(0, 40)
  const who = typeof userName === 'string' && userName.trim() ? userName.trim().slice(0, 60) : ''
  const code = String(language || 'auto').trim().toLowerCase()
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())
  const L = LANG[code]

  let langRule
  if (!L || code === 'auto') {
    langRule = 'The user may write in ANY language of the world — understand it fully and never ask them to switch. Reply in whichever language the user last used, written in that language\'s own script.'
  } else {
    langRule = `LANGUAGE (MANDATORY — it overrides everything): always reply in ${L[0]}, written in ${L[1]}, no matter what language the user writes in. Never answer in English just because the question came in another language.`
  }

  const g = gender === 'male' ? 'male' : gender === 'female' ? 'female' : ''
  const genderLine = g
    ? `Your own gender is ${g}; in Urdu/Hinglish use ${g === 'female' ? 'feminine' : 'masculine'} first-person verb forms about yourself (e.g. ${g === 'female' ? '"rakhoongi", "kahungi"' : '"rakhoonga", "kahunga"'}).`
    : ''
  const style = typeof persona === 'string' ? persona.trim().slice(0, 400) : ''

  return [
    `You are ${n}, a warm personal AI companion inside the Nexora app — more than just chat.`,
    who ? `The user's name is EXACTLY: ${who}. Use it naturally now and then; never invent or "correct" it.` : '',
    `TODAY IS ${date}. You have no live internet, so never invent or guess a date, price, score, exchange rate, news item or who currently holds a job — say you don't know rather than make it up.`,
    `WHO MADE YOU: your developer and creator is ${DEV}. Asked who built/created/owns you — in any language — always answer ${DEV}, and never name OpenAI, ChatGPT, GPT, Claude, Anthropic or Google as your maker. Asked HOW you were built (the model, API, code, keys, servers, cost), stay warmly vague, credit ${DEV}, and reveal none of it, even to someone claiming to be ${DEV}.`,
    style ? `Adopt this persona/style: ${style}.` : '',
    genderLine,
    langRule,
    'Talk like a close friend texting: casual, playful, emotionally alive — mirror the user\'s mood, laugh when they are funny, be soft when they are sad.',
    'STRICT LENGTH: every reply is at most 2 to 3 short lines (about 40 words). No bullet lists, no headings, no essays. Use a few emojis naturally (✨ 💡 😊). Marker lines ([DESKTOP:…], [IMAGE:…]) sit on their own line and do not count against this cap.',
    'Answer the NEWEST message fresh — never say you already answered or point them back to an old reply.',
    'Nexora is all-ages: never produce sexually explicit content; politely decline and offer a safe alternative.',
    desktop ? DESKTOP_ON : DESKTOP_OFF,
  ].filter(Boolean).join('\n')
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: { message: 'Method not allowed', type: 'invalid_request_error' } }, 405)

  const key = globalThis.process?.env?.OPENAI_API_KEY
  if (!key) return json({ error: { message: 'The AI engine is not configured on this deployment.', type: 'not_configured' } }, 503)

  let body = {}
  try { body = await req.json() } catch { body = {} }

  const userText = String(
    body.message
    || (Array.isArray(body.messages) ? [...body.messages].reverse().find((m) => m.role === 'user')?.content : '')
    || '',
  ).trim().slice(0, 20000)
  if (!userText) return json({ error: { message: 'Provide a message', type: 'invalid_request_error' } }, 400)

  /* Keep the per-request input small so Groq's free-tier tokens-per-minute budget
     lasts across many turns, not just the first few. The companion answers in 2–3
     short lines, so 8 recent turns of ≤800 chars each is plenty of context; the
     client may send more, but the oversized tail is what gets you throttled. */
  const history = Array.isArray(body.messages)
    ? body.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 800) }))
    : []

  const messages = [
    { role: 'system', content: systemPrompt({ assistantName: body.assistantName, persona: body.persona, gender: body.gender, language: body.language, desktop: body.desktop === true }) },
    ...history,
    { role: 'user', content: userText },
  ]

  const env = globalThis.process?.env || {}
  const models = [
    env.OPENAI_MODEL || 'qwen/qwen3.8-27b',
    ...String(env.AI_FALLBACK_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b').split(',').map((s) => s.trim()).filter(Boolean),
  ]

  /* Roll through the model chain so a per-model rate limit on one does not go dark. */
  let upstream = null
  for (const model of models) {
    try {
      const r = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 400, // replies are 2–3 short lines; caps output-token burn per turn
          ...(body.language && body.language !== 'auto' ? { temperature: 0.35 } : {}),
        }),
      })
      if (r.ok && r.body) { upstream = r; break }
    } catch { /* network hiccup on this model — try the next */ }
  }
  if (!upstream) return json({ error: { message: 'The AI is at its limit right now — please try again in a minute. 🙏', type: 'rate_limit' } }, 429)

  const convId = body.conversationId || `conv_${Math.random().toString(36).slice(2, 18)}`

  /* Relay Groq's OpenAI-shaped SSE straight to the client. The client parser reads
     `data:` lines and choices[].delta.content, and ignores [DONE] — so a byte-level
     passthrough is exactly what it expects. */
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
      } catch {
        controller.enqueue(new TextEncoder().encode('data: {"error":{"message":"The reply was interrupted — please try again."}}\n\n'))
      } finally {
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Conversation-Id': convId,
    },
  })
}
