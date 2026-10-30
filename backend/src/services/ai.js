import OpenAI from 'openai'
import { config, systemPromptFor, REPLY_LANGUAGE_SCRIPTS } from '../config.js'
import { addTokensUsed } from './quota.js'
import { buildVoiceInstructions } from './realtime.js'

function createClient() {
  if (!config.openaiApiKey) return null
  return new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
  })
}

/* Groq's free tier gives every model its OWN daily token budget, so one exhausted
   model must not black out the whole chat. When the primary call fails for a
   CAPACITY reason (429 / tokens-per-day / overload) we roll through
   config.fallbackModels; a genuine 4xx (bad request, bad key) is NOT retried on
   another model because it would fail there too — we surface it instead. */
const CAPACITY_RE = /(rate.?limit|too many requests|tokens per (day|hour|min|minute)|insufficient_quota|quota|overload|capacity|try again in|\b429\b|\b503\b)/i
function isCapacityError(err) {
  if (!err) return false
  if (err.status === 429 || err.status === 503) return true
  return CAPACITY_RE.test(String(err?.message || err))
}
/* Primary first, then the fallback chain, de-duplicated and empties dropped. */
function modelChain(primary) {
  const seen = new Set()
  const out = []
  for (const m of [primary, ...(config.fallbackModels || [])]) {
    const id = String(m || '').trim()
    if (id && !seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
}

/* Exported for tests: this is the single place that decides how big a turn is, so
   the voice-vs-text prompt choice and the memory placement are asserted here rather
   than inferred from a provider call. */
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
  const systemPrompt = ctx.channel === 'voice'
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
       the provider cannot reach our localhost /uploads). */
    ...history.map((m) => (m.images?.length && m.role === 'user'
      ? {
          role: m.role,
          content: [
            { type: 'text', text: m.content || `The user attached ${m.images.length} image${m.images.length > 1 ? 's' : ''}. Look at ${m.images.length > 1 ? 'them' : 'it'} and reply.` },
            ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        }
      /* An assistant turn is plain text, always. Multimodal array content is only
         legal on a user part, so once her own screenshots started living on
         assistant messages, feeding them back made the provider reject the WHOLE
         request ("for 'role:assistant' ... content must be a string") and bricked
         every later turn in that conversation. She does not need to re-see a picture
         she already described. */
      : { role: m.role, content: m.content })),
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
const URDU_SCRIPT_RE = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/
const SCRIPT_FIXUP = {
  urdu: '(Your previous attempt was written in Roman letters, which the user cannot read. Answer the SAME message again, this time with every word in the Urdu script — e.g. "وہ بالکل ٹھیک ہے، آپ بتائیں آگے کیا ہوا؟". Do not write a single Roman-lettered sentence.)',
  latin: '(Your previous attempt used the Urdu/Arabic script, but the user pinned a Latin-script language. Answer the SAME message again using Roman/Latin letters only.)',
}

/* null = the sample honours the pinned language (also returned when there is
   nothing to judge yet, so a short reply is never retried on a hunch). */
export function scriptViolation(text, language) {
  const wanted = REPLY_LANGUAGE_SCRIPTS[language]
  const body = String(text || '')
  if (!wanted || body.trim().length < 2) return null
  const hasUrdu = URDU_SCRIPT_RE.test(body)
  if (wanted === 'urdu') return hasUrdu ? null : 'urdu'
  /* An Urdu character inside an English or Hinglish reply is the model slipping
     back to the script of the thread, not a bracketed term — both are wrong. */
  return hasUrdu ? 'latin' : null
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
    const source = open({ ...params, extraDirective: attempt > 1 ? SCRIPT_FIXUP[REPLY_LANGUAGE_SCRIPTS[language]] : null })[Symbol.asyncIterator]()
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
  const messages = buildMessages(history, memories, { assistantName, userName, persona, language, gender, channel }, extraDirective)
  const client = createClient()
  let usedModel = model || config.openaiModel

  if (!client) {
    for await (const chunk of mockStream(messages)) {
      if (signal?.aborted) break
      yield { ...chunk, model: 'nexora-mock' }
    }
    return
  }

  const streamReq = {
    messages,
    /* A spoken reply is 1-3 short sentences by rule, so the 900-token text cap is
       dead room on a voice turn that only invites a mini-essay the listener never
       hears the end of. */
    max_tokens: channel === 'voice' ? VOICE_MAX_TOKENS : 900,
    /* When the user pinned a specific language, cool the sampling down so the
       model sticks to the (mandatory) language rule instead of drifting back to
       English/Roman the way it can at the default temperature. */
    ...(language && language !== 'auto' ? { temperature: 0.35 } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
  /* Cross-model failover: an exhausted primary rolls onto the next model. maxRetries:0
     makes a rate-limited model fail FAST so the crossover is immediate instead of the
     SDK re-hammering the same spent model. If every model is busy we rethrow the
     ORIGINAL capacity error so the client still sees the honest "at its limit" line. */
  const chain = modelChain(usedModel)
  let stream = null
  let capacityErr = null
  for (let idx = 0; idx < chain.length; idx += 1) {
    try {
      stream = await client.chat.completions.create({ model: chain[idx], ...streamReq }, { signal, maxRetries: 0 })
      usedModel = chain[idx]
      break
    } catch (err) {
      if (signal?.aborted) throw err
      if (idx === 0 && !isCapacityError(err)) throw err /* a real 4xx won't be fixed by another model */
      if (idx === 0) capacityErr = err
      console.warn(`[nexora] model ${chain[idx]} unavailable — trying fallback: ${String(err?.message || err).slice(0, 120)}`)
    }
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
  const messages = buildMessages(history, memories, { assistantName, userName, persona, language, gender, channel }, extraDirective)
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

  const completeReq = {
    messages,
    max_tokens: channel === 'voice' ? VOICE_MAX_TOKENS : 900,
    ...(language && language !== 'auto' ? { temperature: 0.35 } : {}),
  }
  const chain = modelChain(usedModel)
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
  return providerComplete({ ...params, extraDirective: SCRIPT_FIXUP[verdict] })
}

export function estimateCredits(usage) {
  if (!usage) return 1
  const total = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
  return Math.max(1, Math.ceil(total / 100))
}
