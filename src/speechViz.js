/* Lip-sync bus: turns the words the AI is ACTUALLY speaking into a 0..1 mouth
   opening the particle face reads every frame.

   When an utterance starts we pre-schedule one "syllable peak" per syllable of
   its text, spaced at the voice's speaking rate (so the mouth opens per syllable,
   pauses between words and closes on commas / full stops). Engines that fire
   `onboundary` word events re-anchor the schedule at each word, so the lips stay
   locked to the voice even when the estimated pace drifts; engines that fire no
   boundaries (many phone voices) still get the text-paced schedule. */

const peaks = [] /* { t (s), amp, w (half-width s) } */
let speaking = false
let curText = ''
let curCps = 14
const now = () => performance.now() / 1000
/* UI listeners (the face card's status line) told when speaking starts/stops */
const listeners = new Set()
function notify() { listeners.forEach((fn) => { try { fn(speaking) } catch { /* ignore */ } }) }
export function onSpeechChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function syllables(word) {
  const latin = word.match(/[aeiouyàáâäèéêëìíîïòóôöùúûü]+/gi)
  if (latin) return Math.max(1, latin.length)
  /* Urdu / Hindi / other scripts: roughly one syllable per two letters */
  const letters = word.replace(/[^\p{L}]/gu, '').length
  return Math.max(1, Math.round(letters / 2))
}

function scheduleFrom(fromIdx, t0) {
  /* drop everything not yet spoken — the schedule is rebuilt from here */
  for (let i = peaks.length - 1; i >= 0; i -= 1) if (peaks[i].t > t0) peaks.splice(i, 1)
  const tokens = curText.slice(fromIdx).split(/(\s+)/)
  let t = t0
  for (const tok of tokens) {
    if (!tok) continue
    if (/^\s+$/.test(tok)) { t += 0.05; continue }
    const dur = Math.max(0.12, tok.length / curCps)
    const n = syllables(tok)
    for (let k = 0; k < n; k += 1) {
      peaks.push({ t: t + (dur * (k + 0.45)) / n, amp: 0.55 + Math.random() * 0.45, w: Math.max(0.045, (dur / n) * 0.42) })
    }
    t += dur
    if (/[.!?۔।]$/.test(tok)) t += 0.32
    else if (/[,;:،]$/.test(tok)) t += 0.16
    if (peaks.length > 600) break
  }
}

/** An utterance began playing. `rate` is the engine rate (1 = normal). */
export function speechStart(text, { rate = 1, durationSec = 0 } = {}) {
  curText = String(text || '')
  if (!curText) return
  if (!speaking) { speaking = true; notify() }
  /* ~14 characters per second at rate 1; a known audio duration overrides it */
  curCps = durationSec > 0.3 ? Math.max(6, curText.length / (durationSec * 0.92)) : 14 * (rate || 1)
  scheduleFrom(0, now())
}

/** A word boundary from SpeechSynthesisUtterance.onboundary. */
export function speechWord(charIndex) {
  if (!speaking || !curText || !Number.isFinite(charIndex)) return
  scheduleFrom(charIndex, now())
}

export function speechEnd() {
  peaks.length = 0
  if (speaking) { speaking = false; notify() }
}

export function isSpeechActive() {
  return speaking
}

/** Current mouth opening 0..1 (sum of the nearby syllable bumps). */
export function mouthLevel() {
  if (!speaking && !peaks.length) return 0
  const t = now()
  let v = 0
  for (let i = peaks.length - 1; i >= 0; i -= 1) {
    const p = peaks[i]
    if (p.t < t - 1) { peaks.splice(i, 1); continue }
    const d = (t - p.t) / p.w
    if (d > -3 && d < 3) v = Math.max(v, p.amp * Math.exp(-d * d))
  }
  return v
}

/** Wire an utterance's lifecycle into the bus. Safe to call on any utterance. */
export function trackUtterance(utter) {
  const prevStart = utter.onstart
  const prevBoundary = utter.onboundary
  utter.onstart = (e) => { speechStart(utter.text, { rate: utter.rate }); prevStart?.(e) }
  utter.onboundary = (e) => { if (!e.name || e.name === 'word') speechWord(e.charIndex); prevBoundary?.(e) }
}

/** Wire a playing <audio> element (server TTS) into the bus. */
export function trackAudio(audio, text) {
  const begin = () => speechStart(text, { durationSec: Number.isFinite(audio.duration) ? audio.duration : 0 })
  audio.addEventListener('playing', begin, { once: true })
  audio.addEventListener('ended', speechEnd, { once: true })
  audio.addEventListener('pause', speechEnd, { once: true })
  audio.addEventListener('error', speechEnd, { once: true })
}
