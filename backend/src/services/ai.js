import OpenAI from 'openai'
import { config, systemPromptFor, REPLY_LANGUAGE_SCRIPTS, REPLY_LANGUAGE_NAMES, REPLY_LANGUAGE_SAMPLES, SCRIPT_RANGES, SCRIPT_NAMES, NON_LATIN_RE } from '../config.js'
import { addTokensUsed } from './quota.js'
import { buildVoiceInstructions } from './realtime.js'

function createClient() {
  if (!config.openaiApiKey) return null
  return new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
  })
}

/* ── Token estimation & input-budget fitting ─────────────────────────────────
   Groq free tier gives every model its OWN per-minute input-token window (~7k).
   A single system prompt (~3.9k tokens) plus the conversation history can exceed
   that by mid-thread, making turn 6+ fail 429 and turn 24+ fail 413. The fix:
   estimate the payload size BEFORE sending and trim old history until it fits,
   and treat 413 as a capacity error so the chain can roll. */
const EST_CHARS_PER_TOKEN = 4
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / EST_CHARS_PER_TOKEN)
}
function estimateMessageTokens(messages) {
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') total += estimateTokens(m.content)
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        total += part.type === 'text' ? estimateTokens(part.text) : 1500 /* image overhead */
      }
    }
    total += 4 /* role/separator overhead per message */
  }
  return total
}
/* Trim the oldest non-system messages to fit within `budget` tokens. The system
   message (index 0) and the last user message always survive. */
export function fitToInputBudget(messages, budget) {
  const sys = messages[0]?.role === 'system' ? [messages[0]] : []
  const last = messages[messages.length - 1]
  const middle = messages.slice(sys.length, messages.length - 1)
  let head = sys.length ? 0 : 0 /* nothing to skip */
  while (middle.length - head > 1) {
    const candidate = [...sys, ...middle.slice(head), last]
    if (estimateMessageTokens(candidate) <= budget) return candidate
    head += 1
  }
  /* Even with just the last message, the system prompt + user text may still be
     over — send it anyway so the user gets SOME response instead of a silent error. */
  return [...sys, ...(middle.length > head ? [middle[middle.length - 1]] : []), last]
}

/* ── Model-chain rotation ────────────────────────────────────────────────────
   Each Groq model has its OWN per-minute window, so two turns of one conversation
   can share the load across three models instead of hitting the same limiter twice.
   A simple round-robin counter is incremented on every text-only call that does NOT
   pin a vision model. Image turns always start at the vision model (the only one
   that can see a picture) and never rotate. */
let rotationIdx = 0
/* Non-rotating chain for vision (image) turns — the vision model MUST be first. */
function modelChain(primary) {
  const seen = new Set()
  const out = []
  for (const m of [primary, ...(config.fallbackModels || [])]) {
    const id = String(m || '').trim()
    if (id && !seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
}
function rotatedChain(primary) {
  const seen = new Set()
  const out = []
  for (const m of [primary, ...(config.fallbackModels || [])]) {
    const id = String(m || '').trim()
    if (id && !seen.has(id)) { seen.add(id); out.push(id) }
  }
  if (out.length <= 1) return out
  /* Rotate the starting point for non-vision models (text threads). */
  const offset = rotationIdx % out.length
  rotationIdx += 1
  return [...out.slice(offset), ...out.slice(0, offset)]
}

/* ── Capacity / failover logic ──────────────────────────────────────────────
   Groq rate-limits are 429 (per-minute/per-day) and 413 (request too large for the
   TPM window). Both are recoverable by changing model or reducing payload. */
const CAPACITY_RE = /(rate.?limit|too many requests|tokens per (day|hour|min|minute)|insufficient_quota|quota|overload|capacity|try again in|reduce your message size|request too large|\b429\b|\b413\b|\b503\b)/i
export function isCapacityError(err) {
  if (!err) return false
  if (err.status === 429 || err.status === 413 || err.status === 503) return true
  return CAPACITY_RE.test(String(err?.message || err))
}

/* Exported for tests: this is the single place that decides how big a turn is, so
   the voice-vs-text prompt choice and the memory placement are asserted here rather
   than inferred from a provider call. */
function toolSystemPrompt({ assistantName, userName, persona, language }) {
  const name = String(assistantName || 'Nexora').trim().slice(0, 40) || 'Nexora'
  const code = String(language || 'auto').toLowerCase()
  const langName = REPLY_LANGUAGE_NAMES?.[code]
  return [
    `You are ${name}, the assistant inside the Nexora app, created by ${config.developerName}.`,
    userName ? `The user's name is ${String(userName).slice(0, 60)}.` : '',
    persona ? `Tone: ${String(persona).slice(0, 200)}.` : '',
    'Do the task in the user message directly and completely. Never reveal or name the underlying AI model, provider, API or keys.',
    langName && code !== 'auto'
      ? `Reply in ${langName}.`
      : 'Reply in the language the user wrote in.',
    'Nexora is all-ages: never produce sexual content.',
  ].filter(Boolean).join('\n')
}

export function buildMessages(history, userMemories = [], ctx = {}, extraDirective = null) {
  const memoryBlock = userMemories.length
    ? `\n\nKnown user context:\n${userMemories.map((m) => `- ${m.key}: ${m.value}`).join('\n')}`
    : ''
  /* A spoken turn pays for its instruction sheet on EVERY sentence, and the text
     prompt is ~4.5k tokens of rules a voice call cannot even use: the `[DESKTOP:…]`
     and `[APP:…]` marker blocks would be READ ALOUD by the TTS, the image/screenshot
     blocks are inert in a call, and "use emojis generously" is unspellable. So a
     voice turn answers from the compact spoken sheet — the SAME one the realtime
     session is configured with, which already carries the language override, the
     gender grammar, the 1-3 sentence limit and the creator rules — and the memory
     list rides inside it rather than being appended twice. */
  /* Tools and reminders carry their own focused brief in the user turn, so they get
     a ~150-token identity sheet instead of the ~3.6k-token companion chat prompt.
     That full prompt on every tool run is what tripped the provider's tokens-per-
     minute cap after a handful of calls ("The AI is at its limit"). */
  const systemPrompt = ctx.channel === 'tool'
    ? toolSystemPrompt(ctx) + memoryBlock
    : ctx.channel === 'voice'
    ? buildVoiceInstructions({
        assistantName: ctx.assistantName,
        userName: ctx.userName,
        memories: userMemories,
        persona: ctx.persona,
        language: ctx.language,
        gender: ctx.gender,
      })
    : systemPromptFor(ctx) + memoryBlock

  return [
    { role: 'system', content: systemPrompt },
    /* A turn with attached images becomes OpenAI-style multimodal content — a
       text part plus one image_url part per picture (base64 data URLs, because
       the provider cannot reach our localhost /uploads).
       IMPORTANT: only the NEWEST image-bearing user turn keeps its images. Every
       earlier picture turn is downgraded to text-only (with a small note so the
       model knows a picture was there). Re-inlining every base64 image on every
       turn is what pushed a long chat past Groq's 7k ITPM and produced the
       "AI is at its limit" error the user reported — a single phone photo costs
       ~1.5k tokens, so three old pictures silently cost 4.5k tokens per turn.
       The AI already saw the earlier pictures and answered them once; she does
       not need to re-look at them to keep the thread coherent. */
    ...(() => {
      let newestImageIdx = -1
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].role === 'user' && history[i].images?.length) { newestImageIdx = i; break }
      }
      return history.map((m, idx) => {
        const keepImages = idx === newestImageIdx && m.role === 'user' && m.images?.length
        if (keepImages) {
          return {
            role: m.role,
            content: [
              { type: 'text', text: m.content || `The user attached ${m.images.length} image${m.images.length > 1 ? 's' : ''}. Look at ${m.images.length > 1 ? 'them' : 'it'} and reply.` },
              ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          }
        }
        /* Older image turns: text-only, with a hint so the model knows a picture
           was there and does not hallucinate about it. */
        const hadImages = m.role === 'user' && m.images?.length
        const text = hadImages
          ? `${m.content || ''}\n\n[An image was attached to this earlier turn — the model already saw it then; the picture is not re-attached to save input tokens.]`
          : m.content
        /* An assistant turn is plain text, always. Multimodal array content is only
           legal on a user part, so once her own screenshots started living on
           assistant messages, feeding them back made the provider reject the WHOLE
           request ("for 'role:assistant' ... content must be a string") and bricked
           every later turn in that conversation. */
        return { role: m.role, content: text }
      })
    })(),
    /* A pinned reply language is a hard rule the prompt states twice, yet a small
       model still answers the FIRST turn of a thread in the script it was just
       shown. When that happens the guard below re-asks once, and this is the line
       that tells it what it got wrong — appended last so it is the freshest thing
       in the context. Never saved to the transcript. */
    ...(extraDirective ? [{ role: 'system', content: extraDirective }] : []),
  ]
}

/** Mock ChatGPT-style SSE stream when no API key is set */
async function* mockStream(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  /* Multimodal turns carry an array of parts — read the text part, not the object. */
  const raw = typeof lastUser?.content === 'string' ? lastUser.content : lastUser?.content?.[0]?.text
  const prompt = raw?.trim() || 'Hello'
  const reply =
    `I'm Nexora — your personal AI assistant.\n\n` +
    `You asked: “${prompt.slice(0, 280)}${prompt.length > 280 ? '…' : ''}”\n\n` +
    `This is mock mode (no OPENAI_API_KEY). Add a key in backend/.env to get real model replies. ` +
    `Until then I can still power the full ChatGPT-style streaming UI, conversations, memory, and tools.`

  for (const word of reply.split(/(\s+)/)) {
    if (!word) continue
    yield { content: word }
    await new Promise((r) => setTimeout(r, 12 + Math.random() * 28))
  }
}

/* -------------------------------------------------------------------------
   Language-script enforcement — the prompt can ask, only the code can guarantee.

   Settings stores one of four reply languages and the system prompt calls the
   pinned one MANDATORY twice over, but a small model reading a Roman-typed "hi"
   in an empty thread still drifts into Roman-typed Urdu (Hinglish) — the very
   first reply of a conversation is where it happens, because nothing in the
   context is written in the target script yet to anchor it. A user who picked
   "Urdu first" reads that as the setting being ignored.

   So the opening of every reply is judged before a single character reaches the
   client: SAMPLE_CHARS is held back (it streams in well under a second), the
   script is checked, and on a mismatch the call is closed and re-issued once
   with a corrective directive. Whatever the second attempt produces is streamed
   as-is — a wrong script then costs one retry, never a blocked or empty reply.
   ------------------------------------------------------------------------- */
const SAMPLE_CHARS = 160
const MAX_SCRIPT_ATTEMPTS = 2
/* Completion cap for a spoken turn — 220 tokens is ~160 words, already three times
   the "1 to 3 short sentences" the voice instructions demand, so it constrains only
   the model that was going to ramble. */
const VOICE_MAX_TOKENS = 220

/* The corrective directive, built on demand from the same table the prompt uses.
   Naming the script and (when we have one) showing a real phrase in it is what a
   small model can actually act on — "write in Devanagari" alone is too abstract. */
function scriptFixup(script, language) {
  if (!script) return null
  if (script === 'latin') {
    return `(Your previous attempt used a non-Latin script, but the user pinned a Latin-script language (${REPLY_LANGUAGE_NAMES[language] || 'this language'}). Answer the SAME message again using Roman/Latin letters only — no other alphabet.)`
  }
  const name = SCRIPT_NAMES[script] || script
  const sample = REPLY_LANGUAGE_SAMPLES[language]
  const example = sample ? ` — e.g. "${sample}"` : ''
  return `(Your previous attempt was written in the wrong script, which the user cannot read. Answer the SAME message again, this time entirely in ${name}${example}. Do not write a single sentence in any other script.)`
}

/* null = the sample honours the pinned language (also returned when there is
   nothing to judge yet, so a short reply is never retried on a hunch). The verdict
   value is the SCRIPT name, which is also the key the fixup is built from. */
export function scriptViolation(text, language) {
  const wanted = REPLY_LANGUAGE_SCRIPTS[language]
  const body = String(text || '')
  if (!wanted || body.trim().length < 2) return null
  const re = SCRIPT_RANGES[wanted]
  if (!re) return null
  /* A Latin-pinned language (English, Spanish, Hinglish…) fails when ANY non-Latin
     character appears — the model slipping back to the script of the thread. */
  if (wanted === 'latin') return NON_LATIN_RE.test(body) ? wanted : null
  /* A non-Latin pinned script fails when its own characters are missing from the
     opening sample — the model answered in English or in Roman transliteration. */
  return re.test(body) ? null : wanted
}

const asIterable = (it) => ({ [Symbol.asyncIterator]: () => it })

/* Wraps a stream factory so the client only ever sees text in the right script.
   `open` is injectable so the retry path is testable without a provider. */
export async function* guardedStream(params, open = providerStream) {
  const { language, signal, guard = true } = params
  if (!guard || !REPLY_LANGUAGE_SCRIPTS[language]) {
    yield* open(params)
    return
  }
  for (let attempt = 1; ; attempt += 1) {
    const held = []
    let sample = ''
    let verdict = false /* false = still sampling, null = fine, string = wrong script */
    let finished = false
    const source = open({ ...params, extraDirective: attempt > 1 ? scriptFixup(REPLY_LANGUAGE_SCRIPTS[language], language) : null })[Symbol.asyncIterator]()
    while (true) {
      const step = await source.next()
      if (step.done) { finished = true; break }
      if (signal?.aborted) { await source.return?.(undefined); return }
      held.push(step.value)
      if (step.value.content) sample += step.value.content
      if (sample.length >= SAMPLE_CHARS || step.value.usage) verdict = scriptViolation(sample, language)
    }
    if (verdict === false) verdict = scriptViolation(sample, language)
    if (!verdict) {
      for (const chunk of held) yield chunk
      if (!finished) {
        try {
          for await (const chunk of asIterable(source)) {
            if (signal?.aborted) break
            yield chunk
          }
        } finally {
          await source.return?.(undefined)
        }
      }
      return
    }
    await source.return?.(undefined) /* stop paying for the doomed call */
    if (attempt >= MAX_SCRIPT_ATTEMPTS) {
      for (const chunk of held) yield chunk
      return
    }
  }
}

async function* providerStream({ history, memories, model, assistantName, userName, persona, language, gender, channel, signal, extraDirective }) {
  let messages = buildMessages(history, memories, { assistantName, userName, persona, language, gender, channel }, extraDirective)
  const client = createClient()
  let usedModel = model || config.openaiModel

  if (!client) {
    for await (const chunk of mockStream(messages)) {
      if (signal?.aborted) break
      yield { ...chunk, model: 'nexora-mock' }
    }
    return
  }

  /* Fit the payload to the per-minute input-token budget before sending.
     Images always stay on the newest turn only (the oldest picture turns are
     text-summarised or dropped by trimHistory already). */
  messages = fitToInputBudget(messages, config.aiInputTokenBudget)

  const streamReq = {
    messages,
    max_tokens: channel === 'voice' ? VOICE_MAX_TOKENS : 900,
    ...(language && language !== 'auto' ? { temperature: 0.35 } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
  const isVision = history.some((m) => m.images?.length)
  const chain = isVision ? modelChain(usedModel) : rotatedChain(usedModel)
  let stream = null
  let capacityErr = null
  for (let idx = 0; idx < chain.length; idx += 1) {
    try {
      stream = await client.chat.completions.create({ model: chain[idx], ...streamReq }, { signal, maxRetries: 0 })
      usedModel = chain[idx]
      break
    } catch (err) {
      if (signal?.aborted) throw err
      if (idx === 0 && !isCapacityError(err)) throw err
      if (idx === 0) capacityErr = err
      console.warn(`[nexora] model ${chain[idx]} unavailable — trying fallback: ${String(err?.message || err).slice(0, 120)}`)
    }
  }
  /* If the entire chain is busy AND the error was a capacity issue, do one final
     retry on the last model with a much smaller budget — trim history hard. */
  if (!stream && capacityErr && isCapacityError(capacityErr)) {
    const degradedBudget = Math.floor(config.aiInputTokenBudget * 0.45)
    const degraded = fitToInputBudget(messages, degradedBudget)
    try {
      stream = await client.chat.completions.create({ model: chain[0], ...streamReq, messages: degraded }, { signal, maxRetries: 0 })
      usedModel = chain[0]
      messages = degraded
    } catch { /* fall through to rethrow */ }
  }
  if (!stream) throw capacityErr

  for await (const part of stream) {
    if (signal?.aborted) break
    const delta = part.choices?.[0]?.delta?.content
    if (delta) {
      yield { content: delta, model: usedModel, usage: null }
    }
    if (part.usage) {
      /* Count every model's spend against the one budget the top-bar pill shows.
         The user set that number as the hard daily cap that must reach zero and
         lock the composer; counting only the primary model let failover traffic run
         for free, so the countdown stalled and read "Nk left" while the key was
         actually spent. Tally everything so the number is honest. */
      addTokensUsed(part.usage.total_tokens)
      yield { content: '', model: usedModel, usage: part.usage, finish: true }
    }
  }
}

/* The route-facing entry point: same async generator as before, wrapped in the
   script guard. Mock mode is exempt — the canned reply is always English, so
   re-asking it for a script it cannot change would only slow the demo down. */
export function streamChatCompletion(params) {
  return guardedStream({ ...params, guard: Boolean(config.openaiApiKey) })
}

async function providerComplete({ history, memories, model, assistantName, userName, persona, language, gender, channel, extraDirective }) {
  let messages = buildMessages(history, memories, { assistantName, userName, persona, language, gender, channel }, extraDirective)
  const client = createClient()
  let usedModel = model || config.openaiModel

  if (!client) {
    let text = ''
    for await (const chunk of mockStream(messages)) text += chunk.content
    return {
      content: text,
      model: 'nexora-mock',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
  }

  /* Fit the payload before sending (same as stream path). */
  messages = fitToInputBudget(messages, config.aiInputTokenBudget)

  const completeReq = {
    messages,
    max_tokens: channel === 'voice' ? VOICE_MAX_TOKENS : 900,
    ...(language && language !== 'auto' ? { temperature: 0.35 } : {}),
  }
  const isVision = history.some((m) => m.images?.length)
  const chain = isVision ? modelChain(usedModel) : rotatedChain(usedModel)
  let completion = null
  let capacityErr = null
  for (let idx = 0; idx < chain.length; idx += 1) {
    try {
      completion = await client.chat.completions.create({ model: chain[idx], ...completeReq }, { maxRetries: 0 })
      usedModel = chain[idx]
      break
    } catch (err) {
      if (idx === 0 && !isCapacityError(err)) throw err
      if (idx === 0) capacityErr = err
      console.warn(`[nexora] model ${chain[idx]} unavailable — trying fallback: ${String(err?.message || err).slice(0, 120)}`)
    }
  }
  /* Degraded retry if the chain exhausted on capacity. */
  if (!completion && capacityErr && isCapacityError(capacityErr)) {
    const degradedBudget = Math.floor(config.aiInputTokenBudget * 0.45)
    const degraded = fitToInputBudget(messages, degradedBudget)
    try {
      completion = await client.chat.completions.create({ model: chain[0], ...completeReq, messages: degraded }, { maxRetries: 0 })
      usedModel = chain[0]
    } catch { /* fall through */ }
  }
  if (!completion) throw capacityErr

  addTokensUsed(completion.usage?.total_tokens)

  return {
    content: completion.choices[0]?.message?.content || '',
    model: usedModel,
    usage: completion.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/* Non-streaming twin of guardedStream — used by the idle check-in, where the
   nudge lands in the thread as a saved message and nobody gets to see a retry. */
export async function completeChat(params) {
  const first = await providerComplete(params)
  const verdict = config.openaiApiKey ? scriptViolation(first.content, params.language) : null
  if (!verdict) return first
  return providerComplete({ ...params, extraDirective: scriptFixup(verdict, params.language) })
}

/* Credits are charged for what the user actually gets back (the reply), never for
   the ~3.6k-token system prompt that rides along on every turn: billing that overhead
   used to burn ~40 credits per "hi", so a free account was empty after two messages.
   1 credit per reply, +1 per 200 reply tokens beyond the first 200. When only a
   total is known (aborted streams estimate from the visible text) it is the reply. */
export function estimateCredits(usage) {
  if (!usage) return 1
  const reply = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : (usage.total_tokens || 0)
  return Math.max(1, Math.ceil(reply / 200))
}
