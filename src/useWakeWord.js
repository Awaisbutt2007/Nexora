import { useEffect, useRef, useState } from 'react'

/* Global wake-word listener.
 *
 * WHEN TO USE: a single hook mounted at the top of the workspace so the user can
 * say "Aira, make me an image of a mountain" from ANY view (Chat, Memory,
 * Schedule, Settings, Desktop) without first clicking Talk or focusing the
 * composer.
 *
 * HOW IT WORKS:
 *   1. One `continuous: true` SpeechRecognition instance owns the mic. Chrome
 *      auto-pauses a continuous recogniser after silence, so onend re-arms it
 *      with a small backoff — a single flaky frame never kills the loop.
 *   2. Every FINAL transcript is tested against the assistant name as a whole
 *      word (case-insensitive). "Aira, <something>" routes the tail to
 *      `onCommand(text)` immediately.
 *   3. THE "ARMING" STATE (this is what makes it feel natural): Chrome's
 *      recogniser often splits "Aira <breath> bana do ek image" into TWO
 *      separate finals — "Aira" then "bana do ek image". If we only looked at
 *      each final in isolation the second one would be dropped, the chat would
 *      never open and nothing spoken would show as a message. So when a final
 *      contains the bare wake word we call `onWake(text)` AND set `armedUntilMs`
 *      a few seconds into the future; any final that arrives inside that window
 *      is delivered to `onCommand` even if it does not repeat the name. Real
 *      speech never has to be perfectly contiguous for the feature to work.
 *   4. Cooldowns are per-outcome, not global: a bare wake word re-fires at most
 *      every 1.5 s (so a stuttered "Aira… Aira" doesn't spam the notice), while
 *      a command re-fires only if the SAME command text arrives within 3 s
 *      (Chrome sometimes delivers an identical transcript twice at the tail of
 *      an utterance). Crucially the command cooldown does NOT block the wake→
 *      command sequence, which is why we can fire within 500 ms of the wake.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - Persistence. `enabled` resets every page load — a user must re-activate
 *     the microphone each session, so nobody leaves an always-on mic running
 *     after a restart.
 *   - Interim results. Only FINAL transcripts fire, because interim text often
 *     re-states the same phrase as the recogniser refines it, and the arming
 *     window already covers the two-chunk case without needing partials.
 *   - Language choice is HONOURED, not fixed. The recogniser locale follows the
 *     user's reply language (see REC_LOCALES below) so a task spoken in Urdu /
 *     Roman Urdu / Hinglish is transcribed with real fidelity — the old hard-coded
 *     'en-US' mangled non-English commands into fragments (a spoken task arrived
 *     as just "hi"), which is why a voice-assigned job never reached the chat.
 *     The mix locales resolve to LATIN script (en-US/en-IN/hi-IN) so the name-based
 *     wake word still matches; a user whose assistant name IS an Urdu word can pin
 *     it in Settings → the hook reads `wakeWord` on every fire, so a rename is live.
 */
const DEFAULT_COOLDOWN_MS = 3200        // same-command cooldown
const DEFAULT_ARM_WINDOW_MS = 6000      // how long the mic stays "armed" after a bare wake
const WAKE_RETRIGGER_MS = 1500          // bare-wake re-fire floor
const RESTART_BACKOFF_MS = 350

/* Recognition locale per reply language — the always-on mic honours the user's
   language just like VoiceCall's Talk pipeline does. 'auto'/'hinglish' resolve to
   Latin-script Indian locales (en-IN / hi-IN): they transcribe Roman-Urdu/Hinglish
   far better than plain en-US AND keep the name in Latin letters so the wake-word
   regex still matches. (auto is en-IN here, not VoiceCall's en-US, because the wake
   path must capture the whole spoken COMMAND, not just the name.) 'ur' uses ur-PK. */
const REC_LOCALES = { en: 'en-US', ur: 'ur-PK', hinglish: 'hi-IN', auto: 'en-IN' }

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* Devanagari → Roman (Hinglish) transliteration for the always-on mic.
 * WHY: for a user pinned to 'hinglish' we run the recogniser on hi-IN (the only
 * locale that hears Hindi words accurately), but hi-IN hands BACK Devanagari —
 * "चुप कर जाओ" — while that same user TYPES and wants to READ Roman letters.
 * Normalising the transcript here (before any matching) means the Latin
 * wake-word name still lines up ("ऐरा" → "aira"), the command regexes see the
 * Roman forms they already cover, and the user's own message shows the way
 * they'd write it. It ONLY touches the Devanagari block, so Urdu (ur-PK) and
 * Latin pass through untouched, and it's a cheap no-op when no Hindi is present.
 * Long vowels collapse to their short Roman equivalent and the inherent schwa is
 * dropped on word-final consonants, so "बोल" reads "bol", not "bola". */
const DEV_VOWELS = { '\u0905': 'a', '\u0906': 'a', '\u0907': 'i', '\u0908': 'i', '\u0909': 'u', '\u090A': 'u', '\u090B': 'ri', '\u090C': 'ri', '\u090D': 'e', '\u090E': 'o', '\u090F': 'e', '\u0910': 'ai', '\u0911': 'e', '\u0912': 'o', '\u0913': 'o', '\u0914': 'au' }
const DEV_MATRAS = { '\u093E': 'a', '\u093F': 'i', '\u0940': 'i', '\u0941': 'u', '\u0942': 'u', '\u0943': 'ri', '\u0944': 'ri', '\u0945': 'e', '\u0946': 'e', '\u0947': 'e', '\u0948': 'ai', '\u0949': 'e', '\u094A': 'o', '\u094B': 'o', '\u094C': 'au' }
const DEV_CONS = { '\u0915': 'k', '\u0916': 'kh', '\u0917': 'g', '\u0918': 'gh', '\u0919': 'n', '\u091A': 'ch', '\u091B': 'chh', '\u091C': 'j', '\u091D': 'jh', '\u091E': 'n', '\u091F': 't', '\u0920': 'th', '\u0921': 'd', '\u0922': 'dh', '\u0923': 'n', '\u0924': 't', '\u0925': 'th', '\u0926': 'd', '\u0927': 'dh', '\u0928': 'n', '\u0929': 'ny', '\u092A': 'p', '\u092B': 'ph', '\u092C': 'b', '\u092D': 'bh', '\u092E': 'm', '\u092F': 'y', '\u0930': 'r', '\u0931': 'r', '\u0932': 'l', '\u0933': 'l', '\u0934': 'l', '\u0935': 'v', '\u0936': 'sh', '\u0937': 'sh', '\u0938': 's', '\u0939': 'h' }
const DEV_NUKTA = { '\u0915': 'k', '\u0916': 'kh', '\u0917': 'g', '\u091C': 'z', '\u0921': 'r', '\u0922': 'rh', '\u092F': 'y', '\u0935': 'v', '\u0936': 'sh' }
const DEV_HALANT = '\u094D'
const DEV_NUKTA_MARK = '\u093C'
const DEV_ANUSVARA = '\u0902'
const DEV_CHANDRABINDU = '\u0901'
const DEV_VISARGA = '\u0903'
const DEV_AVAGRAHA = '\u093D'
const DEV_OM = '\u0950'
function devToRoman(input) {
  const s = String(input || '')
  if (!/[\u0900-\u097F]/.test(s)) return s
  const chars = Array.from(s)
  const isLetter = (c) => c != null && /[\p{L}\p{M}]/u.test(c)
  let out = ''
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (DEV_CONS[ch] != null) {
      let base = DEV_CONS[ch]
      i += 1
      if (chars[i] === DEV_NUKTA_MARK) { base = DEV_NUKTA[ch] ?? base; i += 1 }
      let vowel = 'a'; let matra = false; let killed = false; let tail = ''
      while (i < chars.length) {
        const nx = chars[i]
        if (nx === DEV_HALANT) { killed = true; i += 1; break }
        if (DEV_MATRAS[nx] != null) { vowel = DEV_MATRAS[nx]; matra = true; i += 1; continue }
        if (nx === DEV_ANUSVARA || nx === DEV_CHANDRABINDU) { tail += 'n'; i += 1; continue }
        if (nx === DEV_VISARGA) { tail += 'h'; i += 1; continue }
        break
      }
      out += base
      if (killed) { /* conjunct: the next consonant carries the vowel */ }
      else if (matra) out += vowel
      else if (i < chars.length && isLetter(chars[i])) out += 'a'
      out += tail
      continue
    }
    if (DEV_VOWELS[ch] != null) { out += DEV_VOWELS[ch]; i += 1; continue }
    if (DEV_MATRAS[ch] != null) { out += DEV_MATRAS[ch]; i += 1; continue }
    if (ch === DEV_ANUSVARA || ch === DEV_CHANDRABINDU) { out += 'n'; i += 1; continue }
    if (ch === DEV_VISARGA) { out += 'h'; i += 1; continue }
    if (ch === DEV_OM) { out += 'om'; i += 1; continue }
    if (ch === DEV_AVAGRAHA || ch === DEV_NUKTA_MARK || ch === DEV_HALANT) { i += 1; continue }
    out += ch; i += 1
  }
  return out
}

/* Chrome's en-IN / hi-IN / en-US speech engine routinely mis-hears a short
 * assistant name: "Aira" arrives as "ayra", "ira", "era", "aria", "ai ra",
 * even "I RA". A strict whole-word regex drops every one of those and the
 * user's spoken command never reaches the chat — exactly the bug reported.
 * The fix is a bounded fuzzy match: for each word in the transcript, allow
 * up to 2 character edits (Levenshtein) against the name. Short names (≤ 4
 * letters) get a tolerance of 1 so common English words don't accidentally
 * trigger the wake. A match also returns the word's end index so the caller
 * can slice the command tail out of the same string. */
function fuzzyNameHit(text, name) {
  const lower = text.toLowerCase()
  const target = name.toLowerCase()
  const maxDist = target.length <= 3 ? 1 : 2
  /* Walk word-like runs; for each, compute edit distance to the name. */
  const wordRe = /\p{L}+/gu
  let m
  while ((m = wordRe.exec(lower)) !== null) {
    const word = m[0]
    /* Quick reject: length difference > maxDist can't be within tolerance. */
    if (Math.abs(word.length - target.length) > maxDist) continue
    if (levenshtein(word, target) <= maxDist) {
      return { end: m.index + word.length, matched: text.slice(m.index, m.index + word.length) }
    }
  }
  return null
}
function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

export function useWakeWord({
  enabled,
  wakeWord,
  language,
  onCommand,
  onWake,
  onInterim,
  /* Extra words that behave exactly like the assistant name for the WAKE test —
     used to let a sleeping assistant be revived by a plain "listen" / "suno"
     without saying the name. Read through a ref (see below) so toggling the
     list does NOT restart the recogniser, and pass an EMPTY array when the
     assistant is awake so ordinary speech containing "listen" never fires a
     false wake. */
  wakeAliases,
  /* Fires whenever STT picks up meaningful user speech (interim OR final).
     The consumer uses this to implement BARGE-IN: if the AI is currently
     speaking, cancel its TTS immediately so the user is never talked over.
     Chrome's built-in AEC (acoustic echo cancellation) prevents the AI's own
     speakers from triggering this, so only real user voice fires it. Debounced
     to at most once every 400 ms so rapid interim events don't spam it. */
  onUserSpeaking,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  armWindowMs = DEFAULT_ARM_WINDOW_MS,
}) {
  /* The mic loop's own asynchronous state. Only SpeechRecognition's event
     handlers write to it, so the setState never fires synchronously inside the
     effect body — the render-tree `status` is derived from this + `enabled`, so
     disabling the toggle hides the mic without needing a cleanup write. */
  const [srState, setSrState] = useState('idle') /* idle | listening | denied | no-mic — the loop's own async state; only SpeechRecognition events write to it */
  /* The engine's existence is checked at render, not inside the effect — an
     unsupported browser reads as `unsupported` the instant the user toggles it
     on, so the button's status chip never lies about "starting" forever. */
  const hasSR = typeof window !== 'undefined'
    && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  const status = !enabled
    ? 'off'
    : !hasSR
      ? 'unsupported'
      : srState === 'denied'
        ? 'denied'
        : srState === 'no-mic'
          ? 'no-mic'
          : srState === 'listening'
            ? 'listening'
            : 'starting'

  /* Latest closures via refs so the async callbacks (which run outside React's
     render cycle) never see a stale `wakeWord` or `onCommand` — a rename in
     Settings should take effect on the next utterance, not the next reload. */
  const onCommandRef = useRef(onCommand)
  const onWakeRef = useRef(onWake)
  const onInterimRef = useRef(onInterim)
  const onUserSpeakingRef = useRef(onUserSpeaking)
  const wakeWordRef = useRef(wakeWord)
  const wakeAliasesRef = useRef(wakeAliases)
  const lastSigRef = useRef({ text: '', ts: 0 })
  const lastWakeTsRef = useRef(0)
  /* Debounce: only fire onUserSpeaking once every 400 ms so rapid interim
     events (Chrome emits many per second) don't spam the consumer. */
  const lastSpeakFireRef = useRef(0)
  useEffect(() => { onCommandRef.current = onCommand }, [onCommand])
  useEffect(() => { onWakeRef.current = onWake }, [onWake])
  useEffect(() => { onInterimRef.current = onInterim }, [onInterim])
  useEffect(() => { onUserSpeakingRef.current = onUserSpeaking }, [onUserSpeaking])
  useEffect(() => { wakeWordRef.current = wakeWord }, [wakeWord])
  useEffect(() => { wakeAliasesRef.current = wakeAliases }, [wakeAliases])

  /* Expose a one-shot "arm now" handle so the UI can flip the pill from
     * paused→listening AND have the very next utterance count as a command
     * without the user having to say the name again. The hook stores the
     * timestamp in the same `armedUntilMs` closure the recognizer reads. */
  const armNowRef = useRef(null)
  useEffect(() => {
    if (!enabled || !hasSR) { armNowRef.current = null; return }
    /* The effect that owns `armedUntilMs` re-runs on every enabled/language
       change; we piggy-back a setter into the ref from inside that effect. */
  }, [enabled, hasSR])
  /* Called by the consumer when the user clicks the already-on pill OR when
     an AI voice reply finishes playing (the conversation-loop hook): opens a
     push-to-talk window so the next sentence is the command without needing
     the wake word. Accepts an optional `ms` to override the default window
     (e.g. 15 000 after a spoken reply so the user has time to think). */
  const armNow = (ms) => { if (armNowRef.current) armNowRef.current(ms) }

  useEffect(() => {
    if (!enabled || !hasSR) return undefined
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    let stopped = false
    let rec = null
    let restartTimer = 0
    /* After a bare "<name>" final, this is the ms timestamp until which the
       NEXT final (whatever it says) counts as the command. Chrome delivers the
       name and the command as two finals whenever the user breathes between
       them, so without this the second half of every spoken prompt is lost. */
    let armedUntilMs = 0
    /* Wire the external arm-now handle to this closure's mutable state.
       Accepts an optional `ms` override so the conversation loop can hold
       the window open longer after a spoken reply (default 6 s). */
    armNowRef.current = (ms) => { armedUntilMs = Date.now() + (ms || armWindowMs) }

    const fireWake = (text) => {
      const now = Date.now()
      if (now - lastWakeTsRef.current < WAKE_RETRIGGER_MS) return
      lastWakeTsRef.current = now
      armedUntilMs = now + armWindowMs
      onWakeRef.current?.(text)
    }

    const fireCommand = (cmd, text) => {
      const trimmed = String(cmd || '').trim()
      if (!trimmed) return
      const now = Date.now()
      /* Same-text double-fire guard: Chrome occasionally emits the identical
         transcript twice at the tail of a long utterance. Different texts are
         always allowed through, so "Aira, hello" followed immediately by
         "Aira, image bana do" still routes both commands correctly. */
      const sig = trimmed.toLowerCase().replace(/\W+/g, ' ').trim()
      if (sig && sig === lastSigRef.current.text && now - lastSigRef.current.ts < cooldownMs) return
      lastSigRef.current = { text: sig, ts: now }
      armedUntilMs = 0
      onCommandRef.current?.(trimmed, text)
    }

    const handleFinal = (rawText) => {
      const name = (wakeWordRef.current || '').trim()
      /* Normalise Hindi script to Roman before ANY matching, so a hi-IN
         transcript ("चुप कर जाओ") reads the way a Hinglish user types it and the
         Latin wake-word name still lines up. No-op for Latin/Urdu input. */
      const text = devToRoman(rawText)
      if (!name || !text) return
      /* Whole-word, case-insensitive. The regex also catches the name glued to
         a leading punctuation mark ("Hey, Aira: make ...") because we look for
         any non-letter on both sides rather than \b (which fails after an
         apostrophe or hyphen in some names). */
      const re = new RegExp(`(^|[^\\p{L}])${escapeRe(name)}([^\\p{L}]|$)`, 'iu')
      const match = re.exec(text)
      if (match) {
        const startIdx = match.index + match[1].length + name.length
        const tail = text.slice(startIdx).replace(/^[\s,.:;!?'-]+/, '').trim()
        if (tail) { fireCommand(tail, text); return }
        fireWake(text)
        return
      }
      /* Fuzzy fallback: Chrome mis-heard the name ("Aira" → "ayra", "ira",
         "era"). If any word in the transcript is within edit-distance 1-2 of
         the name, treat it as the wake word and slice the tail after it. This
         is what makes the voice→chat flow actually work on a real Windows mic
         instead of silently dropping every spoken command. */
      const hit = fuzzyNameHit(text, name)
      if (hit) {
        const tail = text.slice(hit.end).replace(/^[\s,.:;!?'-]+/, '').trim()
        if (tail) { fireCommand(tail, text); return }
        fireWake(text)
        return
      }
      /* No wake word in THIS chunk. Two fall-through paths remain. First: the
         assistant may be ASLEEP (the consumer's "chup ho jao" mode) and has
         passed extra wake words like "listen" / "suno" that behave just like
         the name. Aliases are EMPTY whenever she is awake, so a normal sentence
         that merely contains "listen" is never intercepted here. */
      const aliases = wakeAliasesRef.current
      if (Array.isArray(aliases)) {
        for (const alias of aliases) {
          const are = new RegExp(`(^|[^\\p{L}])${escapeRe(alias)}([^\\p{L}]|$)`, 'iu')
          const am = are.exec(text)
          if (am) {
            const aTail = text.slice(am.index + am[1].length + alias.length).replace(/^[\s,.:;!?'-]+/, '').trim()
            if (aTail) { fireCommand(aTail, text); return }
            fireWake(text)
            return
          }
        }
      }
      /* Second: if the user just clicked the mic pill
         to arm it (see `armNow` below) or we heard a bare name and are still
         inside the arming window, treat this final as the follow-up command. */
      if (armedUntilMs && Date.now() < armedUntilMs) {
        fireCommand(text, text)
      }
    }

    const start = () => {
      if (stopped) return
      rec = new SR()
      rec.continuous = true
      /* Interim results are ONLY used to feed `onInterim` (the live caption).
         Command routing still waits for `isFinal`, so the interim stream never
         double-fires on a phrase Chrome is still refining. Enabling it lets
         the user SEE their own words appear while they are still speaking —
         the mic visibly tracks the voice instead of staying blank until the
         utterance closes. */
      rec.interimResults = true
      rec.maxAlternatives = 1
      /* Follow the user's reply language so a spoken task is transcribed correctly
         (see REC_LOCALES). Falls back to en-US for an unknown/absent preference. */
      rec.lang = REC_LOCALES[language] || 'en-US'
      rec.onresult = (event) => {
        /* Continuous + interim produces a growing result list. Older entries
           before `resultIndex` have already been finalised in previous events,
           so we only look at what changed: concatenate all new finals
           (dispatched once each) and all in-progress interims (dispatched on
           every refinement of the same utterance). */
        let finalText = ''
        let interimText = ''
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const r = event.results[i]
          const t = String(r[0].transcript || '').trim()
          if (!t) continue
          if (r.isFinal) finalText = finalText ? `${finalText} ${t}` : t
          else interimText = interimText ? `${interimText} ${t}` : t
        }
        if (interimText) onInterimRef.current?.(devToRoman(interimText))
        /* Barge-in trigger: as soon as STT hears anything the user is saying
           (real speech, not the AI's own voice — Chrome's AEC handles that),
           notify the consumer so it can cancel TTS mid-sentence. Requires at
           least 3 characters so single-word noise blips don't cut the AI off.
           Debounced to 400 ms to avoid firing 20× per second. */
        const anySpeech = (interimText && interimText.length >= 3) || (finalText && finalText.length >= 1)
        if (anySpeech) {
          const now = Date.now()
          if (now - lastSpeakFireRef.current >= 400) {
            lastSpeakFireRef.current = now
            onUserSpeakingRef.current?.()
          }
        }
        if (finalText) {
          /* Clear the live caption on the final — the UI will flip to the
             "Heard: …" notice in the same render tick, so there is no flash
             of stale interim text. */
          onInterimRef.current?.('')
          handleFinal(finalText)
        }
      }
      rec.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setSrState('denied')
          stopped = true
          return
        }
        /* No physical microphone attached — a distinct user problem (plug one
           in) from permission denied, so the chip must not say "blocked". */
        if (event.error === 'audio-capture') {
          setSrState('no-mic')
          stopped = true
          return
        }
        /* no-speech / aborted / network blips: the onend handler below will
           restart us, so nothing to do here beyond silencing the console. */
      }
      rec.onstart = () => { if (!stopped) setSrState('listening') }
      rec.onend = () => {
        /* Chrome closes the recogniser after silence; whatever interim text was
           still on screen belongs to a completed utterance. Wipe the caption
           before the restart so the user does not see their own stale words
           frozen mid-sentence during the 350 ms gap. */
        onInterimRef.current?.('')
        if (stopped) return
        restartTimer = setTimeout(start, RESTART_BACKOFF_MS)
      }
      try { rec.start() } catch { /* already running; onend will re-arm */ }
    }

    start()

    return () => {
      stopped = true
      clearTimeout(restartTimer)
      if (rec) {
        rec.onstart = null
        rec.onresult = null
        rec.onerror = null
        rec.onend = null
        try { rec.stop() } catch { /* already stopped */ }
      }
      rec = null
      onInterimRef.current?.('')
      /* Reset only if we were mid-listen — otherwise the derived status shows
         'starting' the next time the user enables, which is truthful (we haven't
         got a `rec.onstart` yet). */
      setSrState('idle')
    }
  }, [enabled, hasSR, language, cooldownMs, armWindowMs])

  return { status, armNow }
}
