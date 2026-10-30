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
 * starts synthesizing while the model is still typing the second one.
 *
 * THE GAP RULE — nothing may wait serially between two sentences.
 * A listener judges her by the silence in the middle of a reply, not by how
 * fast the first word arrives, and the first version of this file had a
 * full round trip hiding in every gap: sentence 2's audio was requested only
 * AFTER sentence 1 finished playing. Now the browser engine is handed each
 * utterance as it becomes known (it runs its own FIFO), and server audio is
 * prefetched one sentence ahead so playback is back to back. Target: the next
 * sentence is underway within ~500ms of the previous one ending.
 *
 * A barge-in or a Stop press aborts the whole queue and every outstanding fetch.
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

/* Server audio currently playing (or fetched but not yet started). Kept
 * on module scope so barge-in from the wake-word hook (which does not sit
 * inside React state) can reach it synchronously. The browser utterance is
 * NOT tracked separately — `window.speechSynthesis.cancel()` from
 * `cancelSpeakQueue` already silences every queued utterance, and holding a
 * reference would just confuse the linter (no code ever reads it back). */
let currentAudio = null
let generation = 0
const pending = []  // queued sentences waiting for their turn on the SERVER path
let playing = false
/* How many utterances the browser engine still owes us. `speechSynthesis` keeps
 * its own FIFO, so a sentence is handed to it the moment it is known instead of
 * waiting for the previous `onend` — see the note on speakOnEngine. */
let engineOutstanding = 0
/* Set as soon as the server refuses a synth for THIS burst. 503 ("no speech key
 * configured", a Groq-only install) is the expected one, but an expired token, an
 * empty wallet or a timeout is just as final — and every attempt we still made was
 * a round trip of dead air hidden in the gap between two sentences, which is the
 * exact thing this file exists to remove. Re-probed on each new burst so a server
 * that recovers is used again without a reload. */
let serverTtsDown = false

/* Markers the barge-in tracker uses so the wake-word hook's `isAiSpeakingLongEnough`
 * knows the pipeline is active. We mirror the same contract `speakAssistantReply`
 * already uses in Nexora.jsx — setAiSpeakingRef stays the single source of truth
 * but this pipeline updates the same values via `onMarkStart`/`onMarkEnd`
 * callbacks the caller wires in. */
let markStart = () => {}
let markEnd = () => {}

/* The barge-in tracker is asked "has she been talking for at least 800ms", and it
 * reads a single start stamp. Marking per SENTENCE broke that: at every sentence
 * boundary the queue briefly reported "not speaking" while the next utterance was
 * already queued, which is exactly the window where her own echo can cancel her.
 * So both markers now fire once per BURST — first sound to last. */
let burstOpen = false
function beginBurst() {
  if (burstOpen) return
  burstOpen = true
  markStart()
}
function endBurst() {
  if (!burstOpen) return
  burstOpen = false
  clearStallPoke()
  markEnd()
}

/* Chrome/Edge on Windows sometimes stops walking the engine's own queue: `onend`
 * fires for the sentence that just finished, `speaking` stays true and the next
 * utterance waits seconds — or the rest of the reply — before starting. Our
 * pipeline cannot cause it and cannot see it, so while the engine owes us an
 * utterance we poke `resume()` every 5s. It is a no-op on a healthy or idle
 * engine, produces no sound of its own and never touches the microphone.
 * The interval is cleared when the burst closes, so an idle tab holds nothing. */
let stallPoke = null
function armStallPoke() {
  if (stallPoke || typeof window === 'undefined') return
  stallPoke = setInterval(() => {
    if (!engineOutstanding) {
      clearStallPoke()
      return
    }
    try {
      const eng = window.speechSynthesis
      if (eng && eng.speaking && !eng.paused) eng.resume()
    } catch { /* ignore */ }
  }, 5000)
}
function clearStallPoke() {
  if (!stallPoke) return
  clearInterval(stallPoke)
  stallPoke = null
}

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
  /* Every utterance still in the engine's queue dies with the cancel() below, so
     their `onend`/`onerror` handlers must not try to close the burst afterwards. */
  engineOutstanding = 0
  clearStallPoke()
  try { if (currentAudio) { currentAudio.pause(); if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src) } } catch { /* ignore */ }
  currentAudio = null
  try { if (window.speechSynthesis) window.speechSynthesis.cancel() } catch { /* ignore */ }
  burstOpen = false
  markEnd()
}

/* Spoken stops the splitter honours: the Latin `.` `!` `?` `…`, the Urdu full stop
 * `۔` and the Devanagari danda `।` `॥`. A reply written in one of those scripts has
 * NONE of the Latin marks, so without them the whole answer reached the engine as a
 * single long utterance that only started after the model finished typing. */
const STOP_CHARS = new Set(['.', '!', '?', '…', '\u06D4', '\u0964', '\u0965'])

/**
 * Split `text` into sentences that are safe to speak independently. A
 * sentence boundary is `.`/`!`/`?`/`…`/`۔`/`।` followed by whitespace or the
 * end of the string (or a line break, which is a stop of its own), PLUS the
 * constraint that the character BEFORE the punctuation is not a digit-dot-digit
 * (avoid decimals like "3.14") and the punctuation is not part of an ellipsis
 * mid-stream. Returns { spoken, remainder } —
 * spoken is everything up to the LAST safe boundary, remainder is the tail
 * still incomplete.
 */
export function splitSentences(text) {
  const out = []
  let cursor = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    /* A newline is a stop even with no punctuation on it: a bulleted reply is
     * otherwise held back until the stream ends and then spoken as ONE utterance,
     * and the engine's pauses *inside* an utterance are far longer than the
     * hand-off between two queued ones — the long delay after "every sentence". */
    if (c === '\n') {
      const line = text.slice(cursor, i).trim()
      if (line) out.push(line)
      cursor = i + 1
      continue
    }
    if (!STOP_CHARS.has(c)) continue
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
 * Enqueue one sentence for speaking.
 *
 * Two engines, two rules, and the difference IS the pause the user hears:
 *  - the browser engine needs no network, so the sentence goes straight into
 *    `speechSynthesis`'s own queue and the engine walks it back to back;
 *  - server audio must be fetched, so sentences play in order from `pending` —
 *    but the NEXT sentence's audio is already being fetched while the current one
 *    is still sounding (see drainQueue).
 * A pure-punctuation fragment (a stray "!" from mid-stream) is dropped: it is not
 * worth its own round trip.
 */
export function queueSentence(text, opts) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return
  if (/^[^A-Za-z\u0600-\u06FF\u0900-\u097F\u3040-\u30FF]+$/.test(trimmed)) return
  const plain = plainForSpeech(trimmed)
  if (!plain) return
  /* A quiet pipeline means this is the first sentence of a new reply: let it probe
     the server again instead of inheriting the last burst's verdict forever. */
  if (!playing && !pending.length && !engineOutstanding) serverTtsDown = false
  if (!opts?.authToken || serverTtsDown) {
    speakOnEngine(plain, opts)
    return
  }
  pending.push({ text: plain, opts })
  drainQueue()
}

async function drainQueue() {
  if (playing) return
  playing = true
  const myGen = generation
  /* Audio for the sentence AFTER the one playing, requested in parallel. Without
   * this overlap the listener sits through a whole synthesis round trip
   * (0.5–1.5s) in every gap, because the old code asked for sentence 2 only after
   * sentence 1 had finished playing. */
  let warming = null
  while (pending.length) {
    if (myGen !== generation) break
    const item = pending[0]
    const prepared = (await (warming || prepareServerAudio(item, myGen)))
    pending.shift()
    warming = pending.length ? prepareServerAudio(pending[0], myGen) : null
    if (myGen !== generation) break
    if (prepared) await playServerAudio(prepared)
    /* No token, or the server refused this burst (not configured / expired /
       out of credits): that sentence is still worth hearing, so it goes to the
       engine while the queue moves on. */
    else speakOnEngine(item.text, item.opts)
  }
  /* Cancelled mid-burst: the in-flight fetch's blob is never played, so release it. */
  if (warming) warming.then((p) => { if (p?.url) URL.revokeObjectURL(p.url) }).catch(() => {})
  playing = false
  if (myGen === generation && !engineOutstanding) endBurst()
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

/**
 * Fetch one sentence's server audio. Resolves to `{ url }`, or `null` when the
 * server cannot voice it — no token, or any failure (a Groq-only install says 503,
 * an expired token says 401, an empty wallet 402). It never rejects, because a
 * prefetch that nobody is awaiting yet would surface as an unhandled rejection.
 */
async function prepareServerAudio(item, myGen) {
  const { language, gender, voice, authToken, names } = item.opts || {}
  if (!authToken || serverTtsDown) return null
  try {
    const blob = await synthesizeSpeech(authToken, { text: item.text, language, gender, voice, names })
    serverTtsDown = false
    if (myGen !== generation) {
      /* Barge-in landed while this was in flight — the audio is never played. */
      return null
    }
    return { url: URL.createObjectURL(blob) }
  } catch (err) {
    /* Latch the whole burst, not just for the 503 a Groq-only install returns: a
       401/402/timeout will fail again on sentence 3, and each doomed attempt is a
       round trip of silence inserted between two sentences. */
    serverTtsDown = true
    if (err?.status !== 503) console.warn('[tts-stream] server synth failed, using browser voice:', err?.message)
    return null
  }
}

function playServerAudio(prepared) {
  return new Promise((resolve) => {
    const audio = new window.Audio(prepared.url)
    currentAudio = audio
    const finish = () => {
      try { URL.revokeObjectURL(prepared.url) } catch { /* ignore */ }
      if (currentAudio === audio) currentAudio = null
      resolve()
    }
    audio.onended = finish
    audio.onerror = finish
    beginBurst()
    audio.play().catch(finish)
  })
}

/**
 * Hand a sentence to the browser's own engine and DO NOT wait for it.
 *
 * This is the fix for the pause after every sentence. `speechSynthesis` already
 * runs a FIFO and starts a queued utterance within a few hundred ms, but the old
 * code awaited each `onend` before creating the next utterance — so every gap
 * paid for a fresh voice lookup and engine warm-up on top of the engine's own
 * transition. On the shipped configuration (a Groq key, so the server path
 * returns 503) that serial await was the ONLY thing between sentences.
 */
function speakOnEngine(plain, opts) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  const myGen = generation
  engineOutstanding += 1
  beginBurst()
  armStallPoke()
  const utter = new SpeechSynthesisUtterance(plain)
  configureUtterForSpeech(utter, getCachedVoices(), { language: opts?.language, gender: opts?.gender })
  const done = () => {
    engineOutstanding = Math.max(0, engineOutstanding - 1)
    opts?.onEnd?.()
    /* Some engines fire end-after-error, and a cancel resets the counter itself. */
    if (myGen === generation && !engineOutstanding && !pending.length && !playing) endBurst()
  }
  utter.onend = done
  utter.onerror = done
  try { window.speechSynthesis.speak(utter) } catch { done() }
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
