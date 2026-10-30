import { useCallback, useEffect, useRef, useState } from 'react'
import { chatOnce, logVoiceTurn, requestVoiceToken } from './api/nexora.js'
import { configureUtterForSpeech } from './voiceSelect.js'
import { Icon } from './icons.jsx'
import './VoiceCall.css'

/* Aira — live speech-to-speech over the OpenAI Realtime API (WebRTC), with an
   automatic FALLBACK pipeline for servers that cannot do realtime.

   Two execution modes, one UI:
   - `realtime` — the browser mints a short-lived client secret from our backend,
     opens a peer connection straight to the provider, and streams mic audio both
     ways. Turn detection, interruption cancelling and truncation happen
     server-side. The waveform is drawn from REAL analyser data.
   - `pipeline` — used whenever `/api/voice/realtime/token` returns 503
     `voice_unavailable` (Groq-only keys, no key at all, or a provider that has
     no realtime endpoint). SpeechRecognition (Chrome/Edge built-in) captures the
     user's turn, a one-shot chat call streams text back, and speechSynthesis
     speaks it aloud. No extra cost, no merchant key required — the call actually
     connects instead of showing "voice not available".
   The mode is chosen once at connect-time from the token response and never
   flips mid-call, so teardown and mute handling stay predictable. */

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

/* SpeechRecognition and speechSynthesis are locale-tagged, not language-named.
   'hinglish' has no locale so we pick hi-IN (the closest supported Urdu/Hindi
   neighbour in every mainstream engine); 'auto' defaults to en-US because that
   recogniser has the widest accent coverage and code-switching still works. */
const REC_LOCALES = { en: 'en-US', ur: 'ur-PK', hinglish: 'hi-IN', auto: 'en-US' }
/* SYN_LOCALES was removed — speakText now delegates locale selection to
   the shared `configureUtterForSpeech` helper (voiceSelect.js) which
   honours an accent-preference chain instead of a single hard locale. */

/* The call copy speaks the assistant's real name, never a hard-coded "Aira", so a
   renamed companion stays consistent with the Talk button that opened the call. */
const buildStatusText = (name) => ({
  'requesting-mic': ['Waking the microphone…', `Allow mic access in the browser prompt to talk with ${name}.`],
  connecting: ['Connecting…', `${name} is picking up.`],
  live: ['', ''],
  ended: ['Call ended', 'Your conversation was saved to history.'],
  error: ['Connection problem', ''],
})

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function VoiceCall({ authToken, user, prefs = {}, onClose }) {
  const [phase, setPhase] = useState('requesting-mic')
  const [micState, setMicState] = useState('idle')
  const [errorText, setErrorText] = useState('')
  const [userLive, setUserLive] = useState('')
  const [airaLive, setAiraLive] = useState('')
  const [turns, setTurns] = useState([])
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [muted, setMuted] = useState(false)
  /* `mode` mirrors modeRef for the render tree — the "Free browser voice"
     chip only shows after startPipeline() flips it, so a realtime call keeps
     its original copy. modeRef is what the async callbacks read (state
     closures in event handlers lag by a render). */
  const [mode, setMode] = useState('realtime')

  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const micRef = useRef(null)
  const ctxRef = useRef(null)
  const inAnalyserRef = useRef(null)
  const outAnalyserRef = useRef(null)
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const timerRef = useRef(0)
  const convRef = useRef(null)
  const liveRef = useRef({ user: '', aira: '', responding: false, history: [] })
  const sendRef = useRef(null)
  const phaseRef = useRef('requesting-mic')
  useEffect(() => { phaseRef.current = phase }, [phase])

  /* Pipeline-mode extras — inert in realtime mode. `modeRef` gates every
     pipeline-only code path (recognition callbacks, mute, teardown) so a shared
     UI can flip cleanly between the two engines without branch-heavy logic. */
  const modeRef = useRef('realtime')
  const recognitionRef = useRef(null)
  const mutedRef = useRef(false)
  useEffect(() => { mutedRef.current = muted }, [muted])

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    clearInterval(timerRef.current)
    try { dcRef.current?.close() } catch { /* already closed */ }
    try { pcRef.current?.close() } catch { /* already closed */ }
    micRef.current?.getTracks().forEach((t) => t.stop())
    ctxRef.current?.close().catch(() => {})
    dcRef.current = null
    pcRef.current = null
    micRef.current = null
    ctxRef.current = null
    inAnalyserRef.current = null
    outAnalyserRef.current = null
    /* Pipeline shutdown: nulling the handlers BEFORE stop() prevents the
       onend callback from re-arming recognition after the overlay is gone.
       speechSynthesis.cancel() also silences any in-flight sentence the user
       never got to hear. Both are safe no-ops in realtime mode. */
    if (recognitionRef.current) {
      recognitionRef.current.onstart = null
      recognitionRef.current.onresult = null
      recognitionRef.current.onerror = null
      recognitionRef.current.onend = null
      try { recognitionRef.current.stop() } catch { /* already stopped */ }
      recognitionRef.current = null
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
  }, [])

  useEffect(() => () => teardown(), [teardown])

  /* Auto-start when the overlay opens. The flag + cancel pair makes StrictMode's
     dev double-mount safe: only the surviving mount actually connects. */
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return undefined
    startedRef.current = true
    let cancelled = false
    const id = setTimeout(() => { if (!cancelled) connectRef.current?.() }, 0)
    return () => { cancelled = true; clearTimeout(id); startedRef.current = false; teardown() }
  }, [teardown])

  /* ---- waveform: mirrors real audio, decays to flat when silent ---- */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx2d = canvas.getContext('2d')
    const bars = new Float32Array(56)
    const scratch = new Uint8Array(128)
    let raf = 0
    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * devicePixelRatio) { canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio }
      ctx2d.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      ctx2d.clearRect(0, 0, w, h)
      const read = (analyser) => {
        if (!analyser) return
        analyser.getByteTimeDomainData(scratch)
        let peak = 0
        for (let i = 0; i < scratch.length; i += 2) peak = Math.max(peak, Math.abs(scratch[i] - 128) / 128)
        return peak
      }
      /* In realtime mode the peer connection's remote stream feeds outAnalyserRef
         and the bars mirror true provider amplitude. Pipeline mode has no visible
         audio graph (speechSynthesis output cannot be tapped) so we drive the
         OUTPUT bars from the speaking state instead — the visual is honest about
         "Aira is talking right now" without pretending to see real amplitude
         that we cannot observe. */
      const speakingState = micState === 'speaking'
      const realOut = read(outAnalyserRef.current) || 0
      const outPeak = realOut > 0
        ? realOut
        : (modeRef.current === 'pipeline' && speakingState ? 0.45 + 0.3 * Math.sin(performance.now() / 190) : 0)
      const inPeak = (micState !== 'muted' && read(inAnalyserRef.current)) || 0
      const speaking = speakingState
      const bw = w / bars.length
      for (let i = 0; i < bars.length; i += 1) {
        /* travelling ripple scaled by the REAL peak — animation never lies */
        const wave = 0.35 + 0.65 * Math.abs(Math.sin((i / bars.length) * Math.PI * 3 + performance.now() / 320))
        const target = i % 2 === 0 ? inPeak * wave : outPeak * wave
        bars[i] += (target - bars[i]) * 0.24
        const bh = Math.max(2, bars[i] * h * 0.92)
        const grad = ctx2d.createLinearGradient(0, h / 2 - bh / 2, 0, h / 2 + bh / 2)
        grad.addColorStop(0, i % 2 ? `rgba(189,108,255,${speaking ? 0.95 : 0.28})` : `rgba(95,208,255,${speaking ? 0.28 : 0.85})`)
        grad.addColorStop(1, i % 2 ? 'rgba(95,208,255,0.5)' : 'rgba(189,108,255,0.5)')
        ctx2d.fillStyle = grad
        ctx2d.beginPath()
        ctx2d.roundRect(i * bw + bw * 0.18, h / 2 - bh / 2, bw * 0.64, bh, bw * 0.32)
        ctx2d.fill()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [micState])

  const pushTurn = useCallback((userText, airaText, interrupted) => {
    if (!userText && !airaText) return
    setTurns((prev) => [...prev.slice(-5), { id: `vt_${prev.length}_${userText.length}`, user: userText, aira: `${airaText}${interrupted ? ' —' : ''}` }])
    if (userText && airaText) {
      logVoiceTurn(authToken, { conversationId: convRef.current, userText, assistantText: airaText })
        .then((r) => { if (r.conversationId) convRef.current = r.conversationId })
        .catch(() => { /* captions stay even if persistence hiccups */ })
    }
  }, [authToken])

  const handleEvent = useCallback((event) => {
    switch (event.type) {
      case 'session.created':
        /* Replay recent turns so context survives across calls (docs:
           conversation.item.create with input_text). */
        for (const item of (liveRef.current.history || [])) {
          sendRef.current?.({ type: 'conversation.item.create', item: { type: 'message', role: item.role === 'assistant' ? 'assistant' : 'user', content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.text }] } })
        }
        setMicState('listening')
        break
      case 'input_audio_buffer.speech_started':
        /* WebRTC: the server auto-cancels + truncates; clear the buffer for
           instant silence and show the interruption truthfully. */
        if (liveRef.current.responding) {
          sendRef.current?.({ type: 'output_audio_buffer.clear' })
          pushTurn(liveRef.current.user, liveRef.current.aira, true)
          liveRef.current = { ...liveRef.current, user: '', aira: '', responding: true }
          setUserLive('')
          setAiraLive('')
          setMicState('interrupted')
          setTimeout(() => setMicState('listening'), 650)
        } else {
          setMicState('listening')
        }
        break
      case 'conversation.item.input_audio_transcription.delta':
        liveRef.current.user += event.delta || ''
        setUserLive(liveRef.current.user)
        break
      case 'conversation.item.input_audio_transcription.completed':
        liveRef.current.user = event.transcript || liveRef.current.user
        setUserLive(liveRef.current.user)
        break
      case 'response.created':
        liveRef.current.responding = true
        setMicState('thinking')
        break
      case 'response.output_audio_transcript.delta':
        liveRef.current.aira += event.delta || ''
        setAiraLive(liveRef.current.aira)
        setMicState('speaking')
        break
      case 'response.output_audio_transcript.done':
        liveRef.current.aira = event.transcript || liveRef.current.aira
        setAiraLive(liveRef.current.aira)
        break
      case 'response.done':
        liveRef.current.responding = false
        pushTurn(liveRef.current.user, liveRef.current.aira, false)
        liveRef.current = { ...liveRef.current, user: '', aira: '' }
        setUserLive('')
        setAiraLive('')
        setMicState('listening')
        break
      case 'error':
        setErrorText(event.error?.message || 'Realtime session error')
        break
      default:
        break
    }
  }, [pushTurn])

  const handleEventRef = useRef(handleEvent)
  handleEventRef.current = handleEvent

  const connectRef = useRef(null)

  async function connect() {
    setPhase('requesting-mic')
    setErrorText('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      micRef.current = stream
      const audioCtx = new AudioContext()
      ctxRef.current = audioCtx
      await audioCtx.resume()
      inAnalyserRef.current = audioCtx.createAnalyser()
      inAnalyserRef.current.fftSize = 256
      audioCtx.createMediaStreamSource(stream).connect(inAnalyserRef.current)

      setPhase('connecting')
      /* Two possible outcomes here: a real ephemeral client secret (realtime
         path) or a 503 `voice_unavailable` from the server because the key is
         Groq-only / not an OpenAI key. In the second case we do NOT surface the
         error to the user — we transparently fall into the browser-pipeline
         mode so a call still connects. Any other failure (network, 401, etc.)
         keeps re-throwing so the real problem is visible. */
      let session = null
      try {
        session = await requestVoiceToken(authToken, {
          voice: prefs.voice,
          language: prefs.language,
          assistantName: prefs.assistantName,
          persona: prefs.persona || undefined,
          gender: prefs.gender,
          conversationId: convRef.current,
        })
      } catch (tokenErr) {
        if (tokenErr.status !== 503) throw tokenErr
      }
      if (!session) return startPipeline()
      convRef.current = session.conversationId || convRef.current

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream))
      const remote = new Audio()
      remote.autoplay = true
      pc.addEventListener('track', (e) => {
        remote.srcObject = e.streams[0]
        outAnalyserRef.current = ctxRef.current.createAnalyser()
        outAnalyserRef.current.fftSize = 256
        ctxRef.current.createMediaStreamSource(e.streams[0]).connect(outAnalyserRef.current)
      })

      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      sendRef.current = (payload) => { if (dc.readyState === 'open') dc.send(JSON.stringify(payload)) }
      liveRef.current.history = session.history || []
      dc.addEventListener('message', (e) => {
        let event
        try { event = JSON.parse(e.data) } catch { return }
        handleEventRef.current(event)
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('ICE gathering timed out — check your network and retry.')), 10_000)
          const onState = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange', onState); resolve() }
          }
          pc.addEventListener('icegatheringstatechange', onState)
        })
      }

      /* Direct WebRTC handshake with the provider using the ephemeral secret —
         the permanent API key never reaches the browser. */
      const sdpRes = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.clientSecret}`, 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      })
      if (!sdpRes.ok) {
        const body = await sdpRes.text().catch(() => '')
        throw new Error(body || `Provider refused the call (${sdpRes.status})`)
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() })

      setPhase('live')
      setSecondsLeft(session.maxSeconds || 1800)
      timerRef.current = setInterval(() => setSecondsLeft((left) => Math.max(0, left - 1)), 1000)

      pc.addEventListener('connectionstatechange', () => {
        if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && phaseRef.current === 'live') {
          setPhase('error')
          setErrorText('The audio connection dropped. Reconnect to continue the conversation.')
        }
      })
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setErrorText('Microphone permission was blocked. Allow it in the browser (padlock icon) and retry.')
      } else if (err.name === 'NotFoundError') {
        setErrorText('No microphone found. Plug one in or pick an input device, then retry.')
      } else if (err instanceof TypeError) {
        /* fetch() rejected at the network layer — the API is down / restarting or
           unreachable. A bare "Failed to fetch" tells the user nothing useful. */
        setErrorText('Could not reach the Nexora voice server. Make sure the API is running (npm run dev:api), then retry.')
      } else {
        setErrorText(err.message || 'Could not start the voice session.')
      }
      setPhase('error')
      teardown()
    }
  }
  connectRef.current = connect

  /* ---- Pipeline mode (browser-native STT → chat → TTS) ----

     Activated by connect() when the realtime token endpoint returns 503. The
     UI (waveform, captions, timer, end call) is the same; only the state
     driver changes — a one-shot SpeechRecognition instance per turn, a
     `chatOnce()` call and a SpeechSynthesisUtterance. Because there is no
     server-side voice engine here, the transcript persistence still uses
     /voice/realtime/turn so a spoken exchange lands in history identically
     to a realtime call. */
  function startPipeline() {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
    if (!SR) {
      /* No realtime AND no browser STT — genuinely nothing to fall back to.
         Show the real reason instead of the previous "voice not available"
         line that used to blame the server. */
      throw new Error('This browser has no built-in speech recognition. Open Nexora in Chrome or Edge to use voice calls.')
    }
    modeRef.current = 'pipeline'
    setMode('pipeline')
    setPhase('live')
    setMicState('listening')
    /* 30-minute cap matches the server default so a forgotten open tab still
       closes cleanly. It is a wall-clock timer, not a provider quota. */
    setSecondsLeft(1800)
    timerRef.current = setInterval(() => setSecondsLeft((left) => Math.max(0, left - 1)), 1000)
    startListeningTurn()
  }

  /* pickVoiceFor was removed — speakText now uses the shared
     `configureUtterForSpeech` helper in voiceSelect.js so the wake ack,
     the streamed chat reply and the VoiceCall pipeline all apply the
     SAME gender-first + accent-chain + rate discipline. */
  /* Each listening turn is a fresh one-shot recogniser. One-shots are more
     reliable than continuous mode for our turn-taking use (Chrome's
     continuous mode sometimes stalls after silence). We accept a shorter
     single-utterance budget and re-arm immediately on end. */
  function startListeningTurn() {
    if (phaseRef.current !== 'live' || modeRef.current !== 'pipeline') return
    if (mutedRef.current) { setMicState('muted'); return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang = REC_LOCALES[prefs.language] || 'en-US'
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 1
    let finalText = ''
    rec.onstart = () => { if (phaseRef.current === 'live') setMicState('listening') }
    rec.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const r = event.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      const shown = (finalText || interim).trim()
      liveRef.current.user = shown
      setUserLive(shown)
    }
    rec.onerror = (event) => {
      /* 'no-speech' and 'aborted' are routine (silence between turns, or our
         own stop() when the user hits End call) — just re-arm. 'not-allowed'
         and 'service-not-allowed' mean the user refused the mic for STT, so
         stop the loop instead of hammering the API. */
      if (event.error === 'no-speech' || event.error === 'aborted') return
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setErrorText('Microphone permission was blocked for speech recognition. Allow it in the browser and retry.')
        setPhase('error')
        teardown()
        return
      }
      /* Network / audio capture hiccups: brief backoff, then try again —
         a single flaky frame should not kill the whole call. */
      setTimeout(() => startListeningTurn(), 500)
    }
    rec.onend = () => {
      if (phaseRef.current !== 'live' || modeRef.current !== 'pipeline') return
      recognitionRef.current = null
      const text = finalText.trim()
      if (!text) { startListeningTurn(); return }
      setUserLive('')
      handlePipelineTurn(text)
    }
    recognitionRef.current = rec
    try { rec.start() } catch { /* already running; the pending onend will re-arm */ }
  }

  async function handlePipelineTurn(userText) {
    setMicState('thinking')
    liveRef.current.user = userText
    liveRef.current.aira = ''
    setAiraLive('')
    try {
      const out = await chatOnce(authToken, {
        message: userText,
        conversationId: convRef.current,
        assistantName: prefs.assistantName,
        persona: prefs.persona,
        gender: prefs.gender,
        language: prefs.language,
      })
      /* Cell may have been closed while the chat call was in-flight. */
      if (phaseRef.current !== 'live' || modeRef.current !== 'pipeline') return
      const aiText = (out.text || '').trim()
      convRef.current = out.conversationId || convRef.current
      if (!aiText) { startListeningTurn(); return }
      liveRef.current.aira = aiText
      setAiraLive(aiText)
      speakText(aiText, () => {
        if (phaseRef.current !== 'live' || modeRef.current !== 'pipeline') return
        pushTurn(userText, aiText, false)
        liveRef.current = { ...liveRef.current, user: '', aira: '' }
        setUserLive('')
        setAiraLive('')
        startListeningTurn()
      })
    } catch (err) {
      if (phaseRef.current !== 'live' || modeRef.current !== 'pipeline') return
      /* A transient failure (rate limit, credit shortfall, network) shouldn't
         lock the user out — reflect the reason inline and keep listening. */
      setErrorText(err.message || 'Nexora could not answer that turn.')
      pushTurn(userText, '(no reply)', false)
      liveRef.current = { ...liveRef.current, user: '', aira: '' }
      setUserLive('')
      setAiraLive('')
      startListeningTurn()
    }
  }

  function speakText(text, onDone) {
    if (!window.speechSynthesis) { onDone(); return }
    /* Voice list is populated asynchronously on some engines. Triggering
       getVoices() early forces the load; a subsequent call inside the handler
       will find it. Not fatal if the voice list is still empty. */
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    /* Shared with the chat's auto-spoken replies so "her" sounds the same in
       both places: same gender-first picker, same per-language accent chain
       (Hinglish on a Windows-only-English install lands on en-IN, not en-GB),
       same mixed-script rate hold-down from voiceSelect.js's LANG_RATE (now
       0.88 for Hinglish) for intelligibility. */
    configureUtterForSpeech(utter, window.speechSynthesis.getVoices(), { language: prefs.language, gender: prefs.gender })
    /* Name respellings ride through normalizeForSpeech inside the shared
       helper, so the call surface corrects "Awais" → "ahwice" for the
       browser's GPM table. The server path keeps the name natural and uses
       an explicit English-pronunciation instruction instead. */
    let settled = false
    const finish = () => { if (!settled) { settled = true; onDone() } }
    /* Both onend and onerror should complete the turn; double-fire is guarded
       because some engines emit end-after-error.  */
    utter.onstart = () => { if (phaseRef.current === 'live' && modeRef.current === 'pipeline') setMicState('speaking') }
    utter.onend = finish
    utter.onerror = finish
    window.speechSynthesis.speak(utter)
  }

  function endCall(reason) {
    clearInterval(timerRef.current)
    if (reason === 'time') setErrorText('Time limit reached — the conversation was saved.')
    if (liveRef.current.user || liveRef.current.aira) {
      pushTurn(liveRef.current.user, liveRef.current.aira, false)
      liveRef.current.user = ''
      liveRef.current.aira = ''
    }
    teardown()
    setPhase('ended')
    if (reason === 'user') setTimeout(onClose, 1200)
  }

  /* Hard stop when the server-side cap is reached */
  useEffect(() => {
    if (phase === 'live' && secondsLeft === 0) endCall('time')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, secondsLeft])

  function toggleMute() {
    const next = !muted
    const track = micRef.current?.getAudioTracks()[0]
    if (track) track.enabled = !next
    /* Write the ref inline BEFORE the pipeline branch — setMuted is async and
       the [muted] effect below only runs after React commits, so
       startListeningTurn() would otherwise read the stale `true` and immediately
       re-mute the call (silently, with the headline stuck on "Muted…"). Same
       reason phaseRef and modeRef are updated inline elsewhere here. */
    mutedRef.current = next
    setMuted(next)
    /* Realtime: the provider sees a silent stream, that is enough. Pipeline:
     * SpeechRecognition is a separate capture, so muting means actively
     * stopping it (which fires onend) and NOT re-arming until unmuted. */
    if (modeRef.current === 'pipeline') {
      if (next) {
        try { recognitionRef.current?.stop() } catch { /* no-op */ }
        setMicState('muted')
      } else {
        setMicState('listening')
        startListeningTurn()
      }
    } else {
      setMicState(next ? 'muted' : 'listening')
    }
  }

  const aiName = prefs.assistantName || 'Aira'
  const STATUS_TEXT = buildStatusText(aiName)

  const headline = phase === 'live'
    ? { listening: 'Listening…', thinking: 'Thinking…', speaking: `${aiName} is speaking`, interrupted: 'You interrupted — got it', muted: `Muted — ${aiName} can’t hear you` }[micState] || 'Ready'
    : STATUS_TEXT[phase]?.[0] || ''

  return (
    <div className="voice-call-overlay" role="dialog" aria-modal="true" aria-label={`Voice call with ${aiName}`}>
      <div className="voice-call-card">
        <button type="button" className="voice-call-close" aria-label="Close voice call" onClick={() => { endCall('user'); onClose() }}>×</button>
        <span className={`voice-orb ${phase === 'live' ? micState : phase}`} aria-hidden="true"><Icon name="sparkle" size={28} /></span>
        <h3 className="voice-headline">{headline}</h3>
        <p className="voice-sub">{phase === 'error' ? errorText : STATUS_TEXT[phase]?.[1] || ''}</p>

        <canvas ref={canvasRef} className="voice-wave" aria-hidden="true" />

        <div className="voice-caption" aria-live="polite">
          {turns.slice(-2).map((t) => (
            <div key={t.id} className="voice-turn">
              <p><b>You</b> {t.user}</p>
              {t.aira && <p><b>{aiName}</b> {t.aira}</p>}
            </div>
          ))}
          {userLive && <p><b>You</b> {userLive}</p>}
          {airaLive && <p><b>{aiName}</b> {airaLive}<span className="chat-cursor" aria-hidden="true" /></p>}
        </div>

        {phase === 'live' && <p className="voice-timer">{fmt(secondsLeft)} left · {mode === 'pipeline' ? 'Free browser voice (no realtime key needed)' : 'this call is live, not a demo'}</p>}

        <div className="voice-actions">
          {phase === 'error' && <button type="button" className="voice-btn primary" onClick={connect}>Retry</button>}
          {phase !== 'live' && phase !== 'requesting-mic' && phase !== 'connecting' && <button type="button" className="voice-btn primary" onClick={connect}>Start voice call</button>}
          {phase === 'live' && (
            <>
              <button type="button" className={`voice-btn ${muted ? 'primary' : ''}`} aria-pressed={muted} onClick={toggleMute}>{muted ? 'Unmute mic' : 'Mute mic'}</button>
              <button type="button" className="voice-btn end" onClick={() => { endCall('user'); onClose() }}>End call</button>
            </>
          )}
          {(phase === 'requesting-mic' || phase === 'connecting') && <button type="button" className="voice-btn end" onClick={() => { teardown(); onClose() }}>Cancel</button>}
          {phase === 'ended' && <button type="button" className="voice-btn" onClick={onClose}>Done</button>}
        </div>
        <p className="voice-privacy">Audio streams live and is never stored — only transcripts save to your history.</p>
        {user?.isDemo && phase === 'live' && <p className="voice-demo">Demo account: usage spends Starter credits.</p>}
      </div>
    </div>
  )
}
