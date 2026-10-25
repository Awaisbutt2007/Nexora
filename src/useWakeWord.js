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

export function useWakeWord({
  enabled,
  wakeWord,
  language,
  onCommand,
  onWake,
  onInterim,
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
  const wakeWordRef = useRef(wakeWord)
  const lastSigRef = useRef({ text: '', ts: 0 })
  const lastWakeTsRef = useRef(0)
  useEffect(() => { onCommandRef.current = onCommand }, [onCommand])
  useEffect(() => { onWakeRef.current = onWake }, [onWake])
  useEffect(() => { onInterimRef.current = onInterim }, [onInterim])
  useEffect(() => { wakeWordRef.current = wakeWord }, [wakeWord])

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

    const handleFinal = (text) => {
      const name = (wakeWordRef.current || '').trim()
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
      /* No wake word in THIS chunk. That's usually background speech — but if
         we just heard a bare "<name>" and are still inside the arming window,
         treat this final as the follow-up command. Strip leading filler
         words that Chrome sometimes carries over from the previous chunk. */
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
        if (interimText) onInterimRef.current?.(interimText)
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

  return status
}
