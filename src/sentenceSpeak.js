/**
 * Sentence-streaming TTS pipeline for the workspace chat.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old flow waited for the assistant's whole reply to land and *then*
 * fired one big `/api/voice/synth` request. Even with a 2-3-line reply that
 * costs 1.5–2s of streaming + 500ms–1s of synthesis = the user hears the
 * first sound roughly 2.5–3s after the model started typing. In a spoken
 * conversation that is an uncomfortable silence, and every voice-first user
 * notice ("she's laggy") traces back to it.
 *
 * WHAT THIS DOES
 * --------------
 * Splits the arriving text at sentence boundaries (`.`, `!`, `?`, `…` plus
 * a following whitespace or another sentence start) and fires a TTS request
 * for each complete sentence **as it appears**, so the very first sentence
 * starts synthesizing while the model is still typing the second one. The
 * audio for each sentence is queued and plays strictly in order; a barge-in
 * or a Stop press aborts the whole queue and every outstanding fetch.
 *
 * The queue is a tiny generator-token state machine rather than a class so
 * it can live as a module singleton shared between `sendPrompt` (chat) and
 * any proactive-message speak path, and cancel cleanly from the wake-word
 * barge-in handler without prop drilling.
 *
 * Cancellation contract
 * ---------------------
 * `cancelSpeakQueue()` bumps the generation token, closes the current audio
 * (server blob OR browser utterance), and every queued sentence's `.then`
 * sees the mismatched token and skips play. Outstanding fetches whose blobs
 * arrive after cancel are dropped (their audio URL is revoked).
 */
import { synthesizeSpeech } from './api/nexora.js'
import { configureUtterForSpeech, getCachedVoices } from './voiceSelect.js'

/* Server-side audio currently playing (or fetched but not yet started). Kept
 * on module scope so barge-in from the wake-word hook (which does not sit
 * inside React state) can reach it synchronously. The browser utterance is
 * NOT tracked separately — `window.speechSynthesis.cancel()` from
 * `cancelSpeakQueue` already silences every queued utterance, and holding a
 * reference would just confuse the linter (no code ever reads it back). */
let currentAudio = null
let generation = 0
const pending = []  // queued sentence strings waiting for their turn
let playing = false

/* Markers the barge-in tracker uses so the wake-word hook's `isAiSpeakingLongEnough`
 * knows the pipeline is active. We mirror the same contract `speakAssistantReply`
 * already uses in Nexora.jsx — setAiSpeakingRef stays the single source of truth
 * but this pipeline updates the same values via `onMarkStart`/`onMarkEnd`
 * callbacks the caller wires in. */
let markStart = () => {}
let markEnd = () => {}

/**
 * Wire the barge-in tracker. Called once from Nexora.jsx so the streaming
 * queue and the wake-word hook share the same speaking state.
 */
export function setSpeakMarkers(onStart, onEnd) {
  markStart = onStart
  markEnd = onEnd
}

/**
 * Cancel everything in flight — barge-in, Stop-press, new-sendPrompt.
 * Bumps the generation token so any promise still awaiting its fetch sees
 * the mismatch and drops its audio. Safe to call from anywhere.
 */
export function cancelSpeakQueue() {
  generation += 1
  pending.length = 0
  playing = false
  try { if (currentAudio) { currentAudio.pause(); if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src) } } catch { /* ignore */ }
  currentAudio = null
  try { if (window.speechSynthesis) window.speechSynthesis.cancel() } catch { /* ignore */ }
  markEnd()
}

/**
 * Split `text` into sentences that are safe to speak independently. A
 * sentence boundary is `.`/`!`/`?`/`…` followed by whitespace or the end of
 * the string, PLUS the constraint that the character BEFORE the punctuation
 * is not a digit-dot-digit (avoid decimals like "3.14") and the punctuation
 * is not part of an ellipsis mid-stream. Returns { spoken, remainder } —
 * spoken is everything up to the LAST safe boundary, remainder is the tail
 * still incomplete.
 */
export function splitSentences(text) {
  const out = []
  let cursor = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue
    /* Decimal guard: 3.14 must not split. */
    if (c === '.' && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue
    /* Followed by end-of-string or whitespace = a real boundary. */
    const next = text[i + 1]
    if (next !== undefined && !/\s/.test(next)) continue
    const sentence = text.slice(cursor, i + 1).trim()
    if (sentence) out.push(sentence)
    cursor = i + 1
  }
  return { spoken: out, remainder: text.slice(cursor) }
}

/**
 * Enqueue one sentence for speaking. Sentences play in strict order: the
 * first one starts as soon as its audio is fetched, the next waits for the
 * previous to end. Sentences shorter than 15 chars are still queued unless
 * they are pure punctuation (a stray "!" from mid-stream is not worth its
 * own TTS round trip).
 */
export function queueSentence(text, opts) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return
  if (/^[^A-Za-z\u0600-\u06FF\u0900-\u097F\u3040-\u30FF]+$/.test(trimmed)) return
  pending.push({ text: trimmed, opts })
  drainQueue()
}

async function drainQueue() {
  if (playing) return
  playing = true
  const myGen = generation
  while (pending.length) {
    if (myGen !== generation) { playing = false; return }
    const { text, opts } = pending.shift()
    await speakOneSentence(text, opts, myGen)
  }
  playing = false
}

/* Pre-clean markdown/emoji so the TTS engine doesn't say "asterisk bold
 * asterisk" or "heavy black heart". Same pipeline as the legacy
 * `speakAssistantReply` — kept here so streaming and non-streaming paths
 * stay equivalent. */
function plainForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' (code shown in chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\p{Emoji_Modifier}\p{Variation_Selector}\p{Regional_Indicator}\p{Join_Control}\p{Me}]/gu, '')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900)
}

async function speakOneSentence(text, opts, myGen) {
  const plain = plainForSpeech(text)
  if (!plain) return
  const { language, gender, voice, authToken, onEnd } = opts || {}
  /* Server TTS path — tried first when there's a session token. */
  if (authToken) {
    try {
      const blob = await synthesizeSpeech(authToken, { text: plain, language, gender, voice })
      /* Barge-in fired during the fetch: throw away the audio, do not play. */
      if (myGen !== generation) return
      await new Promise((resolve) => {
        const url = URL.createObjectURL(blob)
        const audio = new window.Audio(url)
        currentAudio = audio
        audio.onended = () => {
          try { URL.revokeObjectURL(url) } catch { /* ignore */ }
          if (currentAudio === audio) currentAudio = null
          if (myGen === generation) markEnd()
          resolve()
          onEnd?.()
        }
        audio.onerror = () => {
          try { URL.revokeObjectURL(url) } catch { /* ignore */ }
          if (currentAudio === audio) currentAudio = null
          if (myGen === generation) markEnd()
          resolve()
        }
        markStart()
        audio.play().catch(() => { if (myGen === generation) markEnd(); resolve() })
      })
      return
    } catch (err) {
      /* 503 = not configured (Groq-only install), fall through silently to the
         browser path. Any other error we also fall through — the reply still
         needs to be heard. */
      if (err && err.status !== 503) console.warn('[tts-stream] server synth failed, using browser voice:', err.message)
    }
  }
  /* Browser TTS fallback. Uses the same gender/accent chain as the wake ack. */
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  await new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(plain)
    configureUtterForSpeech(utter, getCachedVoices(), { language, gender })
    utter.onend = () => { if (myGen === generation) markEnd(); resolve(); onEnd?.() }
    utter.onerror = () => { if (myGen === generation) markEnd(); resolve() }
    markStart()
    try { window.speechSynthesis.speak(utter) } catch { resolve() }
  })
}

/**
 * Public entry that mirrors the old `speakAssistantReply` API but goes
 * through the sentence queue. If the reply has NO sentence boundary the
 * whole text becomes one sentence and plays; if it does (which is the
 * common case for a 2-3-line reply), each part plays sequentially.
 */
export function streamSpeakReply(fullText, opts) {
  const { spoken, remainder } = splitSentences(fullText)
  if (spoken.length === 0 && remainder) {
    /* Single sentence with no trailing punctuation — speak it whole. */
    queueSentence(remainder, opts)
    return
  }
  for (const s of spoken) queueSentence(s, opts)
  if (remainder.trim()) queueSentence(remainder, opts)
}

/**
 * Streaming feed: called on every `onDelta` with the CURRENT total
 * accumulated text. We track how far we have already spoken via `spokeIdx`
 * so subsequent calls only enqueue NEW sentence tails, and we return the
 * updated index. The caller stores that index and passes it back next time.
 */
export function streamFeed(fullText, spokeIdx, opts) {
  if (typeof fullText !== 'string') return spokeIdx
  if (fullText.length <= spokeIdx) return spokeIdx
  const tail = fullText.slice(spokeIdx)
  const { spoken, remainder } = splitSentences(tail)
  for (const s of spoken) queueSentence(s, opts)
  return spokeIdx + tail.length - remainder.length
}

/**
 * Called when the model stream finishes. If there is any trailing partial
 * sentence (no punctuation) that never got flushed, we speak it now so the
 * reply is complete. `spokeIdx` is what streamFeed last returned; the
 * difference from `fullText.length` is the pending tail.
 */
export function streamFinal(fullText, spokeIdx, opts) {
  const tail = (fullText || '').slice(spokeIdx).trim()
  if (tail) queueSentence(tail, opts)
  return spokeIdx + tail.length
}
