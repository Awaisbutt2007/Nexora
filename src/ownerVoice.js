/* Owner voice lock — the assistant only obeys the voice of the account owner.
 *
 * WHY IN THE BROWSER: the live Vercel deploy has no Express backend, so the
 * server-side /api/voice/enroll + /verify pair cannot run there. Everything here
 * is plain Web Audio, works on a static deploy and never uploads audio.
 *
 * HOW IT WORKS:
 *   1. A "tap" opens its own mic stream next to SpeechRecognition (Chrome allows
 *      both at once) and turns every ~11 ms hop into an MFCC frame + loudness.
 *      Only FEATURES are kept (a 30 s ring buffer) — never raw audio.
 *   2. A frame counts as speech when it is ≥ 12 dB above a self-tracking noise
 *      floor, so fan hum / silence never enters the voiceprint.
 *   3. Enrollment: the owner reads a few short lines. Their voiced frames give a
 *      per-coefficient mean + spread (the voiceprint). Leave-one-out scoring of
 *      the lines against each other calibrates THIS owner's own threshold, so
 *      the lock adapts to the mic and voice instead of a magic constant.
 *   4. Verify: when a spoken command lands, the voiced frames of the last few
 *      seconds are scored against the print (normalised mean distance + spread
 *      shape). Too little speech → 'unsure', which is accepted only if the owner
 *      was verified moments ago (a short "haan" mid-conversation still works).
 *
 * HONEST LIMITS: this is a statistical voiceprint, not a neural x-vector model.
 * It reliably tells clearly different voices apart (another adult, a child, a
 * TV) but a similar-sounding voice or a recording of the owner can pass. It is a
 * convenience lock for a personal assistant, not bank-grade identity proof. */

const STORE_PREFIX = 'nexora_owner_voice_v1:'
const RING_SECONDS = 30
const FRAME_SIZE = 1024
const HOP_SIZE = 512
const N_MELS = 32
const N_CEPS = 19 /* c1..c19 — c0 (overall loudness) is dropped so mic gain / distance don't matter */
const MEL_LOW_HZ = 80
const MEL_HIGH_HZ = 7600
const VOICED_MARGIN_DB = 12
const ABS_MIN_DB = -62
const VERIFY_WINDOW_MS = 8000
const MIN_VERIFY_SECONDS = 0.5
const SESSION_TRUST_MS = 20000

export const STRICTNESS = { relaxed: 1.3, normal: 1, strict: 0.8 }

/* ---------- DSP ---------- */

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700) }
function melToHz(mel) { return 700 * (10 ** (mel / 2595) - 1) }

function buildMelBank(sampleRate) {
  const bins = FRAME_SIZE / 2 + 1
  const high = Math.min(MEL_HIGH_HZ, sampleRate / 2 - 100)
  const lowMel = hzToMel(MEL_LOW_HZ)
  const highMel = hzToMel(high)
  const points = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(lowMel + (i * (highMel - lowMel)) / (N_MELS + 1)))
  const binOf = (hz) => Math.floor(((FRAME_SIZE + 1) * hz) / sampleRate)
  return Array.from({ length: N_MELS }, (_, m) => {
    const a = binOf(points[m]); const b = binOf(points[m + 1]); const c = binOf(points[m + 2])
    const w = new Float32Array(bins)
    for (let k = a; k < b; k += 1) w[k] = (k - a) / Math.max(1, b - a)
    for (let k = b; k < c; k += 1) w[k] = (c - k) / Math.max(1, c - b)
    return w
  })
}

/* DCT-II rows for c1..cN, precomputed once. */
const DCT = Array.from({ length: N_CEPS }, (_, i) => {
  const row = new Float32Array(N_MELS)
  for (let m = 0; m < N_MELS; m += 1) row[m] = Math.cos((Math.PI * (i + 1) * (m + 0.5)) / N_MELS)
  return row
})

const HANN = (() => {
  const w = new Float32Array(FRAME_SIZE)
  for (let i = 0; i < FRAME_SIZE; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1))
  return w
})()

/* In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang); const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0
      for (let j = 0; j < len / 2; j += 1) {
        const a = i + j; const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function makeFrameAnalyzer(sampleRate) {
  const bank = buildMelBank(sampleRate)
  const re = new Float32Array(FRAME_SIZE)
  const im = new Float32Array(FRAME_SIZE)
  const power = new Float32Array(FRAME_SIZE / 2 + 1)
  const logMel = new Float32Array(N_MELS)
  return (samples) => {
    let energy = 0
    /* Pre-emphasis flattens the spectral tilt so the high bands carry weight. */
    let prev = samples[0]
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const s = samples[i]
      energy += s * s
      re[i] = (s - 0.97 * prev) * HANN[i]
      im[i] = 0
      prev = s
    }
    const db = 10 * Math.log10(energy / FRAME_SIZE + 1e-12)
    fft(re, im)
    for (let k = 0; k < power.length; k += 1) power[k] = re[k] * re[k] + im[k] * im[k]
    for (let m = 0; m < N_MELS; m += 1) {
      const w = bank[m]
      let sum = 0
      for (let k = 0; k < power.length; k += 1) if (w[k]) sum += w[k] * power[k]
      logMel[m] = Math.log(sum + 1e-10)
    }
    const ceps = new Float32Array(N_CEPS)
    for (let i = 0; i < N_CEPS; i += 1) {
      const row = DCT[i]
      let sum = 0
      for (let m = 0; m < N_MELS; m += 1) sum += row[m] * logMel[m]
      ceps[i] = sum
    }
    return { db, ceps }
  }
}

/* ---------- the mic tap (singleton, ref-counted) ---------- */

let tap = null
let tapUsers = 0
let tapStarting = null

async function openTap() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  const src = ctx.createMediaStreamSource(stream)
  /* ScriptProcessor is deprecated but universally available and needs no
     separate worklet file in the build; the per-hop work is tiny. */
  const node = ctx.createScriptProcessor(2048, 1, 1)
  const analyze = makeFrameAnalyzer(ctx.sampleRate)
  const hopMs = (HOP_SIZE / ctx.sampleRate) * 1000
  const maxFrames = Math.ceil((RING_SECONDS * 1000) / hopMs)
  const frames = []
  const pending = new Float32Array(FRAME_SIZE * 4)
  let pendingLen = 0
  let noiseFloor = -50
  let lastDb = -100
  node.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0)
    if (pendingLen + input.length > pending.length) pendingLen = 0
    pending.set(input, pendingLen)
    pendingLen += input.length
    let offset = 0
    while (pendingLen - offset >= FRAME_SIZE) {
      const { db, ceps } = analyze(pending.subarray(offset, offset + FRAME_SIZE))
      /* Floor drops instantly to quieter frames and creeps up slowly, so it
         follows the room's noise without ever latching onto speech. */
      noiseFloor = db < noiseFloor ? db : noiseFloor + 0.02
      lastDb = db
      const voiced = db > noiseFloor + VOICED_MARGIN_DB && db > ABS_MIN_DB
      frames.push({ t: Date.now(), voiced, ceps })
      if (frames.length > maxFrames) frames.splice(0, frames.length - maxFrames)
      offset += HOP_SIZE
    }
    pending.copyWithin(0, offset, pendingLen)
    pendingLen -= offset
  }
  src.connect(node)
  /* A ScriptProcessor only runs while connected to the destination; it writes
     nothing to its output buffer so nothing is heard. */
  node.connect(ctx.destination)
  if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* resumes on next gesture */ } }
  return {
    hopSec: HOP_SIZE / ctx.sampleRate,
    /* 0..1 loudness above the room's noise — drives the enrollment orb. */
    level() { return Math.max(0, Math.min(1, (lastDb - noiseFloor) / 35)) },
    voicedSince(t0, t1 = Date.now()) {
      return frames.filter((f) => f.voiced && f.t >= t0 && f.t <= t1).map((f) => f.ceps)
    },
    close() {
      node.onaudioprocess = null
      try { src.disconnect(); node.disconnect() } catch { /* already gone */ }
      stream.getTracks().forEach((tr) => tr.stop())
      ctx.close().catch(() => {})
    },
  }
}

/* Acquire the shared tap. Returns a release function; the mic closes when the
   last user releases it. */
export async function acquireVoiceTap() {
  tapUsers += 1
  if (!tap) {
    if (!tapStarting) tapStarting = openTap().then((t) => { tap = t; return t }).finally(() => { tapStarting = null })
    try { await tapStarting } catch (err) { tapUsers -= 1; throw err }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    tapUsers -= 1
    if (tapUsers <= 0 && tap) { tap.close(); tap = null; tapUsers = 0 }
  }
}

export function isTapLive() { return Boolean(tap) }

export function tapLevel() { return tap ? tap.level() : 0 }

/* ---------- voiceprint math ---------- */

function stats(frameSets) {
  const all = frameSets.flat()
  const mu = new Float64Array(N_CEPS)
  const sd = new Float64Array(N_CEPS)
  for (const f of all) for (let i = 0; i < N_CEPS; i += 1) mu[i] += f[i]
  for (let i = 0; i < N_CEPS; i += 1) mu[i] /= Math.max(1, all.length)
  for (const f of all) for (let i = 0; i < N_CEPS; i += 1) sd[i] += (f[i] - mu[i]) ** 2
  for (let i = 0; i < N_CEPS; i += 1) sd[i] = Math.max(1e-3, Math.sqrt(sd[i] / Math.max(1, all.length - 1)))
  return { mu: Array.from(mu), sd: Array.from(sd) }
}

/* Lower = closer. Mean term: how far the utterance's average timbre sits from
   the owner's, in units of the owner's own frame spread. Shape term: whether
   the utterance varies the way the owner's voice varies. */
function distance(print, frames) {
  const s = stats([frames])
  let meanTerm = 0
  let shapeTerm = 0
  for (let i = 0; i < N_CEPS; i += 1) {
    meanTerm += ((s.mu[i] - print.mu[i]) / print.sd[i]) ** 2
    shapeTerm += Math.abs(Math.log(s.sd[i] / print.sd[i]))
  }
  return Math.sqrt(meanTerm / N_CEPS) + 0.5 * (shapeTerm / N_CEPS)
}

/* Short utterances have noisier averages, so the bar is looser below ~2 s. */
function effectiveThreshold(print, seconds, strictness) {
  const mult = STRICTNESS[strictness] || 1
  return print.threshold * mult * (1 + 0.6 * Math.max(0, 2 - seconds))
}

export const MIN_PHRASE_SECONDS = 1.2

/* Build a voiceprint from ≥ 3 recorded phrases (arrays of voiced frames). */
export function buildVoiceprint(phrases) {
  const usable = phrases.filter((p) => p.length * (tap?.hopSec || 0.0107) >= MIN_PHRASE_SECONDS)
  if (usable.length < 3) throw new Error('Not enough clear speech was captured — please record again a little louder.')
  const print = stats(usable)
  /* Leave-one-out: how far does each of the owner's OWN lines sit from a print
     built from the others? That spread is this owner's natural variation. */
  const loo = usable.map((p, i) => {
    const others = stats(usable.filter((_, j) => j !== i))
    return distance({ ...others, threshold: 1 }, p)
  })
  const worst = Math.max(...loo)
  const threshold = Math.min(1.4, Math.max(0.4, worst * 1.8 + 0.12))
  return { ...print, threshold, loo, frames: usable.reduce((n, p) => n + p.length, 0) }
}

/* ---------- persistence ---------- */

const keyFor = (userKey) => `${STORE_PREFIX}${userKey || 'local'}`

export function loadOwnerVoice(userKey) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(userKey)) || 'null')
    return raw && Array.isArray(raw.mu) && raw.mu.length === N_CEPS ? raw : null
  } catch { return null }
}

export function saveOwnerVoice(userKey, record) {
  try { localStorage.setItem(keyFor(userKey), JSON.stringify(record)) } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('nexora-owner-voice', { detail: { userKey } }))
}

export function clearOwnerVoice(userKey) {
  try { localStorage.removeItem(keyFor(userKey)) } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('nexora-owner-voice', { detail: { userKey } }))
}

/* ---------- live verification ---------- */

let boundaryMs = 0
let lastOwnerMs = 0

/* Score the speech heard since the previous verified utterance (capped to the
   last few seconds). Resolves to { verdict: 'owner'|'stranger'|'unsure'|'off', score, limit, seconds }. */
export function verifyRecentSpeech(record) {
  if (!record || record.enabled === false) return { verdict: 'off' }
  if (!tap) return { verdict: 'unsure', reason: 'mic-tap-not-running' }
  const now = Date.now()
  const frames = tap.voicedSince(Math.max(boundaryMs, now - VERIFY_WINDOW_MS), now)
  boundaryMs = now
  const seconds = frames.length * tap.hopSec
  if (seconds < MIN_VERIFY_SECONDS) {
    const trusted = now - lastOwnerMs < SESSION_TRUST_MS
    return { verdict: trusted ? 'owner' : 'unsure', seconds }
  }
  const score = distance(record, frames)
  const limit = effectiveThreshold(record, seconds, record.strictness)
  const verdict = score <= limit ? 'owner' : 'stranger'
  if (verdict === 'owner') lastOwnerMs = now
  else lastOwnerMs = 0
  console.info(`[owner-voice] ${verdict} score=${score.toFixed(3)} limit=${limit.toFixed(3)} speech=${seconds.toFixed(1)}s`)
  return { verdict, score, limit, seconds }
}

/* Capture voiced frames for `ms` milliseconds (enrollment). Calls onLevel(0..1)
   with the share of the target speech gathered so far. */
export function capturePhrase(ms, onProgress) {
  return new Promise((resolve, reject) => {
    if (!tap) { reject(new Error('Microphone is not running.')); return }
    const start = Date.now()
    const timer = setInterval(() => {
      const elapsed = Date.now() - start
      onProgress?.(Math.min(1, elapsed / ms))
      if (elapsed >= ms) {
        clearInterval(timer)
        resolve(tap ? tap.voicedSince(start) : [])
      }
    }, 100)
  })
}

export function phraseSeconds(frames) { return frames.length * (tap?.hopSec || 0.0107) }

/* The refusal line, in the assistant's voice and gender. */
export function strangerReply(ownerName, gender) {
  const owner = (ownerName || '').trim().split(/\s+/)[0] || 'owner'
  const verb = gender === 'male' ? 'maanta' : 'maanti'
  return `Sorry, main sirf apne owner ${owner} ki baat ${verb} hoon. Aap ki awaaz meray owner ki nahi hai.`
}
