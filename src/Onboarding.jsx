import { useEffect, useRef, useState } from 'react'
import { loadSession, updateProfile } from './api/nexora.js'
import NanoParticles from './NanoParticles.jsx'
import { Icon } from './icons.jsx'
import { useVoiceEnrollment } from './OwnerVoiceSetup.jsx'
import './Onboarding.css'

const AI_PROFILE_KEY = 'nexora_ai_profile'

/* Survives refreshes: which stage the user was on + whatever they typed */
const PROGRESS_KEY = 'nexora_onboarding_progress'

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null')
  } catch {
    return null
  }
}

/* Typewriter text for each stage (typed line by line, \n = enter) */
const GREETINGS = [
  'Hi!\nWhat is your name?',
  'Lovely name!\nWhat do you want to name me?',
  'Almost there…\nI have no voice yet. Choose one.',
  'One last thing…\nTeach me YOUR voice.',
  'Everything is ready.\nSay hello to your AI.',
]

/* Persona lists per gender — every preview speaks Roman Urdu in the role's own tone */
const CHARACTERS = {
  female: [
    { id: 'girlfriend', name: 'Girlfriend', desc: 'Flirty, teasing & romantic', line: 'O humnasa… roz tum se baat kiye bina din guzarta hi nahi. Chal batao, aaj mere liye kya laye ho?' },
    { id: 'partner', name: 'Partner', desc: 'Loyal, caring life partner', line: 'Main hoon na tumhare saath, har khushi aur har gham mein. Bas tum kaho, main har mushkil aasan kar doongi.' },
    { id: 'bestfriend', name: 'Best Friend', desc: 'Fun, honest & always hyping you', line: 'Arey meri jaan! Tu jo bhi kare, teri yaar hamesha tere saath khari hai, bas lage raho!' },
    { id: 'assistant', name: 'Assistant', desc: 'Sharp chief-of-staff energy', line: 'Assalam o alaikum. Kaam ki baat karte hain — bataiye, aaj ka poora plan mujhe schedule karna hai?' },
    { id: 'listener', name: 'Listener', desc: 'Calm, caring, judgement-free', line: 'Aaram se… ek ek lafz sun rahi hoon main. Yahan koi faisla nahi hoga, bas dil khol ke baat karo.' },
  ],
  male: [
    { id: 'boyfriend', name: 'Boyfriend', desc: 'Flirty, teasing & romantic', line: 'O jaan… roz tum se baat kiye bina din guzarta hi nahi. Chal batao, aaj mere liye kya layi ho?' },
    { id: 'partner', name: 'Partner', desc: 'Loyal, caring life partner', line: 'Main hoon na tumhare saath, har khushi aur har gham mein. Bas tum kaho, main har mushkil aasan kar doonga.' },
    { id: 'bestfriend', name: 'Best Friend', desc: 'Fun, honest & always hyping you', line: 'Arey mere bhai! Tu jo bhi kare, tera yaar hamesha tere saath khara hai, bas lage raho!' },
    { id: 'assistant', name: 'Assistant', desc: 'Sharp chief-of-staff energy', line: 'Assalam o alaikum. Kaam ki baat karte hain — bataiye, aaj ka poora plan mujhe schedule karna hai?' },
    { id: 'listener', name: 'Listener', desc: 'Calm, caring, judgement-free', line: 'Aaram se… ek ek lafz sun raha hoon main. Yahan koi faisla nahi hoga, bas dil khol ke baat karo.' },
  ],
}

/* Each persona keeps its own delivery. The stage-2 preview AND the stage-3 reveal
   read the SAME profile, so the voice you pick is the voice you keep hearing. The
   old bug: the reveal spoke everyone at a flat 0.95, which sounded like the first
   (Girlfriend) sample no matter who you chose. rate = speed, pitch = brightness. */
const VOICE_PROFILES = {
  girlfriend: { rate: 1.0, pitch: 0.06 },
  boyfriend: { rate: 1.0, pitch: 0.06 },
  partner: { rate: 0.96, pitch: 0 },
  bestfriend: { rate: 1.12, pitch: 0.08 },
  assistant: { rate: 1.03, pitch: -0.02 },
  listener: { rate: 0.82, pitch: -0.08 },
}
const voiceProfile = (id) => VOICE_PROFILES[id] || { rate: 0.98, pitch: 0 }

function saveAiProfile(patch) {
  try {
    const current = JSON.parse(localStorage.getItem(AI_PROFILE_KEY) || '{}')
    localStorage.setItem(AI_PROFILE_KEY, JSON.stringify({ ...current, ...patch }))
  } catch { /* private mode */ }
}

/* The reveal stage's spoken self-introduction: the greeting plus one fixed
   invitation, worded exactly as the user asked for it — deliberately NO
   relationship label ("aap ki girlfriend") and no persona tag-line, so the
   function needs no character/gender. CHARACTERS[].line is only the stage-2
   persona preview now. */
const REVEAL_LINE = 'Chalo, batao aaj tumhare dil aur dimagh mein kya chal raha hai?'

function buildIntro(userName, aiName) {
  const who = aiName.trim() || 'Nexora'
  const human = userName.trim()
  const hello = human ? `Hi ${human}! Main ${who} hoon` : `Hi! Main ${who} hoon`
  return `${hello}. ${REVEAL_LINE}`
}

/* 4 animated bars: real spectrum when an analyser is attached, gentle fake wave otherwise */
function WaveBars({ analyserRef }) {
  const barsRef = useRef([])
  useEffect(() => {
    let raf = 0
    const data = new Uint8Array(analyserRef?.current?.frequencyBinCount || 32)
    const tick = (t) => {
      const analyser = analyserRef?.current
      if (analyser) analyser.getByteFrequencyData(data)
      barsRef.current.forEach((bar, i) => {
        if (!bar) return
        let v
        if (analyser) {
          const bin = Math.max(1, Math.floor(((i + 1) / 4) * data.length) - 1)
          v = Math.max(0.18, (data[bin] / 255) * 1.1)
        } else {
          v = 0.3 + 0.55 * Math.abs(Math.sin(t / 170 + i * 1.9))
        }
        bar.style.transform = `scaleY(${v.toFixed(3)})`
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [analyserRef])
  return (
    <span className="wave">
      {[0, 1, 2, 3].map((i) => <i key={i} ref={(el) => { barsRef.current[i] = el }} />)}
    </span>
  )
}

/**
 * Onboarding shown after a new Google sign-in / account sign-up:
 * 1. user's name (saved to backend)  2. name for the AI  3. voice + persona
 * 4. owner voice enrollment (Siri-style: read 4 lines so only this voice can
 *    give spoken commands; skippable, Settings keeps it reachable)  5. reveal.
 */
export default function Onboarding({ userProfile, source = 'google', onComplete }) {
  /* Restore the last saved step so a refresh never throws the user back to step 1 */
  const savedRef = useRef(null)
  if (!savedRef.current) {
    const loaded = loadProgress()
    savedRef.current = loaded && loaded.source === source ? loaded : {}
  }
  const saved = savedRef.current
  const [stage, setStage] = useState(() => (saved.stage > 0 && saved.stage < GREETINGS.length ? saved.stage : 0))
  /* The name typed at sign-up (or from Google) pre-fills the field — asking for it
     a second time from blank felt like the first answer was lost. Still editable. */
  const [name, setName] = useState(typeof saved.name === 'string' ? saved.name : (String(userProfile?.name || '').trim().slice(0, 40)))
  const [aiName, setAiName] = useState(typeof saved.aiName === 'string' ? saved.aiName : '')
  const [typedCount, setTypedCount] = useState(0)
  const [voiceGender, setVoiceGender] = useState(saved.voiceGender === 'male' ? 'male' : 'female')
  const [character, setCharacter] = useState(() => {
    if (!saved.characterId) return null
    const known = [...CHARACTERS.female, ...CHARACTERS.male].find((c) => c.id === saved.characterId)
    return known || { id: saved.characterId, name: saved.characterName || 'Custom voice', desc: 'Custom voice' }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const updatedUserRef = useRef(null)
  const fileInputRef = useRef(null)
  const audioElRef = useRef(null)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const nameQueueRef = useRef([])
  const recognitionRef = useRef(null)
  const transcribeWatchdogRef = useRef(null)
  const [customVoices, setCustomVoices] = useState([])
  /* voiceId -> { status: 'idle'|'listening'|'done'|'error', text, error } */
  const [transcripts, setTranscripts] = useState({})
  const [playingId, setPlayingId] = useState(null)
  const [naming, setNaming] = useState(null)
  const [voiceName, setVoiceName] = useState('')
  /* Reveal stage: the Back / Enter buttons stay hidden until Aira finishes speaking */
  const [introDone, setIntroDone] = useState(false)
  /* Owner voice enrollment (stage 3). Keyed exactly like the workspace's lock
     (account id, else email) so the print recorded here is the one it checks. */
  const ownerKey = userProfile?.id || userProfile?.email
  const enrollment = useVoiceEnrollment({ userKey: ownerKey, ownerName: name || userProfile?.name, aiName: aiName.trim() || 'Aira' })

  const STEPS = [
    source === 'signup' ? 'Account created' : 'Google connected',
    'Pick your name',
    'Name your AI',
    'Choose a voice',
    'Your voice',
  ]
  /* Which particle shape to show on the current stage: orb until the voice is
     picked, then the chosen gender portrait (there is no custom-face step). */
  const particleShape = stage <= 1 ? 'orb' : voiceGender

  /* Reveal text: greeting + the fixed invitation line (also what gets spoken) */
  const introLine = buildIntro(name, aiName)

  /* Stage 1 greets the human back with the name they just typed */
  const greeting = stage === 1 && name.trim()
    ? `Lovely name, ${name.trim()}!\n${GREETINGS[1].split('\n')[1]}`
    : stage === 4
      ? introLine
      : GREETINGS[stage]

  /* Restart the typewriter whenever the stage (text) changes */
  useEffect(() => setTypedCount(0), [stage])

  /* Persist progress on every change (refresh-safe) */
  useEffect(() => {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify({
        source,
        stage,
        name,
        aiName,
        voiceGender,
        characterId: character?.id || null,
        characterName: character?.name || null,
        characterDesc: character?.desc || null,
      }))
    } catch { /* private mode */ }
  }, [source, stage, name, aiName, voiceGender, character])

  /* Typewriter loop: slight random delay per key, longer pause after line breaks */
  useEffect(() => {
    if (typedCount >= greeting.length) return undefined
    const char = greeting[typedCount]
    const delay = char === '\n' ? 420 : char === ' ' ? 45 : 55 + Math.random() * 70
    const timer = setTimeout(() => setTypedCount((count) => count + 1), delay)
    return () => clearTimeout(timer)
  }, [typedCount, greeting])

  /* Stop any voice preview when the page unmounts */
  useEffect(() => () => stopPlayback(), [])

  /* Only one voice may play at a time */
  function stopPlayback() {
    window.speechSynthesis?.cancel()
    if (transcribeWatchdogRef.current) {
      clearTimeout(transcribeWatchdogRef.current)
      transcribeWatchdogRef.current = null
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.abort() } catch { /* already stopped */ }
      recognitionRef.current = null
    }
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.src = ''
      audioElRef.current = null
    }
    analyserRef.current = null
    setPlayingId(null)
  }

  const typedLines = greeting.slice(0, typedCount).split('\n')
  const progress = ((stage + 1) / STEPS.length) * 100

  /* Stage 1: save the human's name on the backend, then move on */
  const handleNameSubmit = async (event) => {
    event.preventDefault()
    const clean = name.trim()
    if (!clean || saving) return
    setSaving(true)
    setError('')
    try {
      const token = loadSession()?.token
      const data = await updateProfile(token, { name: clean })
      updatedUserRef.current = data.user
    } catch (err) {
      setError(err.message || 'Could not save your name — you can retry later.')
    }
    setSaving(false)
    setStage(1)
  }

  /* Stage 2: name the AI */
  const handleAiNameSubmit = (event) => {
    event.preventDefault()
    const clean = aiName.trim()
    if (!clean || saving) return
    setSaving(true)
    saveAiProfile({ aiName: clean })
    setTimeout(() => {
      setSaving(false)
      setStage(2)
    }, 250)
  }

  /* Stage 3: hear a character — always in Urdu, in the role's own tone.
     The line is broken into clauses and each one gets its own pitch/rate
     contour (! rises & speeds up, … pauses & softens, ? lifts at the end),
     which reads as real emotion instead of a flat monotone. */
  const previewVoice = (char) => {
    const wasPlaying = playingId === char.id
    stopPlayback()
    setCharacter(char)
    if (wasPlaying || !('speechSynthesis' in window)) return
    const voices = window.speechSynthesis.getVoices()
    const genderName = voiceGender === 'female' ? /female|zira|samantha|aria|veena|kalpana/i : /male|david|mark|george|ravi|hemant/i
    const score = (v) =>
      (/^ur/i.test(v.lang) ? 5 : /^hi/i.test(v.lang) ? 4 : 0)
      + (/natural|neural|online|premium|enhanced/i.test(v.name) ? 2 : 0)
      + (genderName.test(v.name) ? 1 : 0)
    const voice = voices.slice().sort((a, b) => score(b) - score(a))[0]
    const prof = voiceProfile(char.id)
    const basePitch = (voiceGender === 'female' ? 1.15 : 0.9) + prof.pitch
    const baseRate = prof.rate
    const segments = char.line.split(/(?<=[…!?.])\s+/).filter(Boolean)
    segments.forEach((text, i) => {
      const punch = /[!?]$/.test(text) ? 0.24 : /…$/.test(text) ? -0.14 : 0
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'ur-PK'
      if (voice && score(voice) > 0) utterance.voice = voice
      utterance.pitch = Math.min(1.7, Math.max(0.5, basePitch + punch + (i % 2 === 0 ? 0.06 : -0.05)))
      utterance.rate = Math.min(1.4, Math.max(0.7, baseRate + (punch > 0 ? 0.08 : punch < 0 ? -0.1 : 0)))
      utterance.onstart = () => setPlayingId(char.id)
      utterance.onerror = () => setPlayingId(null)
      if (i === segments.length - 1) utterance.onend = () => setPlayingId(null)
      window.speechSynthesis.speak(utterance) /* queued back-to-back in order */
    })
  }

  /* Switching gender drops a persona that does not exist in the new list */
  const changeGender = (gender) => {
    if (gender === voiceGender) return
    stopPlayback()
    setVoiceGender(gender)
    if (character && !character.id.startsWith('dev-') && !CHARACTERS[gender].some((c) => c.id === character.id)) {
      setCharacter(null)
    }
  }

  /* Browse the device's own recordings / voice videos */
  const handleFiles = (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    nameQueueRef.current = files.map((f) => ({
      url: URL.createObjectURL(f),
      suggestion: f.name.replace(/\.[^.]+$/, '').slice(0, 40),
    }))
    askNextVoiceName()
  }

  const askNextVoiceName = () => {
    const next = nameQueueRef.current.shift()
    if (!next) {
      setNaming(null)
      setVoiceName('')
      return
    }
    setNaming(next)
    setVoiceName(next.suggestion)
  }

  const saveVoiceName = () => {
    if (!naming || !voiceName.trim()) return
    const voice = { id: `dev-${Date.now()}`, name: voiceName.trim(), url: naming.url }
    setCustomVoices((list) => [...list, voice])
    askNextVoiceName()
    /* Auto-scan the just-added recording: its spoken words drop straight
       into the row, the same way the built-in voices show their own text. */
    setTimeout(() => transcribeVoice(voice), 400)
  }

  /* Play/stop a device recording with a live spectrum analyser behind the bars */
  const toggleFileVoice = (voice) => {
    if (playingId === voice.id) {
      stopPlayback()
      return
    }
    stopPlayback()
    setCharacter({ id: voice.id, name: voice.name, desc: 'Custom voice' })
    try {
      const audio = new Audio(voice.url)
      audioElRef.current = audio
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) {
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx()
        audioCtxRef.current.resume?.()
        const source = audioCtxRef.current.createMediaElementSource(audio)
        const analyser = audioCtxRef.current.createAnalyser()
        analyser.fftSize = 64
        source.connect(analyser)
        analyser.connect(audioCtxRef.current.destination)
        analyserRef.current = analyser
        audio.onended = () => { stopPlayback(); try { source.disconnect() } catch { /* already gone */ } }
      } else {
        audio.onended = () => stopPlayback()
      }
      audio.play().catch(() => setPlayingId(null))
      setPlayingId(voice.id)
    } catch {
      setPlayingId(null)
    }
  }

  /* Turn a device recording into words. The browser's SpeechRecognition can
     only listen through the microphone, so we play the file out loud and let
     the mic hear it at the same time, transcribing the spoken words live. */
  const srErrorText = (code) => {
    if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone access was blocked — allow the mic to transcribe.'
    if (code === 'no-speech') return 'No speech was picked up. Play the recording out loud (turn the volume up) and try again.'
    if (code === 'network') return 'Speech service needs a network connection.'
    if (code === 'audio-capture') return 'No microphone was found.'
    return 'Could not transcribe this recording.'
  }

  const transcribeVoice = (voice) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setTranscripts((m) => ({ ...m, [voice.id]: { status: 'error', text: '', error: 'Speech recognition is not available here — use Chrome or Edge over HTTPS/localhost.' } }))
      return
    }
    stopPlayback()
    /* NOTE: scanning does NOT pick the voice — selection only happens when the
       user actually plays/chooses it, so Continue stays disabled until then. */
    setTranscripts((m) => ({ ...m, [voice.id]: { status: 'listening', text: '', error: '' } }))

    const rec = new SR()
    recognitionRef.current = rec
    rec.lang = 'ur-PK'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    let finalText = ''
    let fellBack = false
    const write = (patch) => setTranscripts((m) => ({ ...m, [voice.id]: { ...m[voice.id], ...patch } }))
    const clearWatchdog = () => {
      if (transcribeWatchdogRef.current) { clearTimeout(transcribeWatchdogRef.current); transcribeWatchdogRef.current = null }
    }

    rec.onstart = () => console.info('[transcribe] listening started for', voice.name)
    rec.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const t = event.results[i][0].transcript
        if (event.results[i].isFinal) { finalText += (finalText ? ' ' : '') + t }
        else interim += t
      }
      write({ status: 'listening', text: `${finalText} ${interim}`.trim() })
    }
    rec.onerror = (event) => {
      console.warn('[transcribe] error:', event.error)
      /* ur-PK may be unsupported → retry once with the browser's own language */
      if ((event.error === 'language-not-supported' || event.error === 'bad-language') && !fellBack) {
        fellBack = true
        rec.lang = navigator.language || 'en-US'
        try { rec.start() } catch (err) { write({ status: 'error', error: `Could not start: ${err.message}` }) }
        return
      }
      clearWatchdog()
      write({ status: 'error', error: srErrorText(event.error) })
    }
    rec.onend = () => {
      clearWatchdog()
      recognitionRef.current = null
      setPlayingId((id) => (id === voice.id ? null : id))
      setTranscripts((m) => {
        const cur = m[voice.id]
        if (cur && cur.status === 'listening') {
          return { ...m, [voice.id]: { status: 'done', text: finalText || cur.text, error: finalText || cur.text ? '' : 'No words detected — play the recording out loud (volume up) and try again.' } }
        }
        return m
      })
    }

    /* play the recording out loud so the mic can capture it */
    const audio = new Audio(voice.url)
    audioElRef.current = audio
    audio.onended = () => { setTimeout(() => { try { rec.stop() } catch { /* already ended */ } }, 900) }
    audio.play().catch((err) => {
      console.warn('[transcribe] audio play failed:', err)
      write({ status: 'error', text: '', error: 'This file could not be played — pick an audio/video format your browser supports.' })
      try { rec.abort() } catch { /* not started */ }
    })
    setPlayingId(voice.id)
    try {
      rec.start()
      /* watchdog: never leave the button stuck on "Listening…" */
      transcribeWatchdogRef.current = setTimeout(() => { try { rec.stop() } catch { /* gone */ } }, 15000)
    } catch (err) {
      clearWatchdog()
      console.warn('[transcribe] start() threw:', err)
      write({ status: 'error', text: '', error: `Could not start the microphone (${err.message || 'unknown'}). If a permission prompt appeared, allow it and try again.` })
    }
  }

  const handleVoiceContinue = () => {
    if (!character) return
    stopPlayback()
    saveAiProfile({ voiceGender, character: character.id, characterName: character.name, characterDesc: character.desc })
    setStage(3)
  }

  /* Speak a Roman-Urdu line clause-by-clause with emotional pitch/rate contour */
  const speakLine = (text, { onstart, onend } = {}) => {
    if (!('speechSynthesis' in window)) { onend?.(); return }
    window.speechSynthesis.cancel()
    const voices = window.speechSynthesis.getVoices()
    const genderName = voiceGender === 'female' ? /female|zira|samantha|aria|veena|kalpana/i : /male|david|mark|george|ravi|hemant/i
    const score = (v) =>
      (/^ur/i.test(v.lang) ? 5 : /^hi/i.test(v.lang) ? 4 : 0)
      + (/natural|neural|online|premium|enhanced/i.test(v.name) ? 2 : 0)
      + (genderName.test(v.name) ? 1 : 0)
    const voice = voices.slice().sort((a, b) => score(b) - score(a))[0]
    /* Use the SAME persona profile as the preview, so the reveal reflects the
       character the user actually picked instead of a one-size-fits-all tone. */
    const prof = voiceProfile(character?.id)
    const basePitch = (voiceGender === 'female' ? 1.15 : 0.9) + prof.pitch
    const segments = text.replace(/\n/g, ' ').split(/(?<=[…!?.])\s+/).filter(Boolean)
    segments.forEach((seg, i) => {
      const punch = /[!?]$/.test(seg) ? 0.24 : /…$/.test(seg) ? -0.14 : 0
      const u = new SpeechSynthesisUtterance(seg)
      u.lang = 'ur-PK'
      if (voice && score(voice) > 0) u.voice = voice
      u.pitch = Math.min(1.7, Math.max(0.5, basePitch + punch + (i % 2 === 0 ? 0.06 : -0.05)))
      u.rate = Math.min(1.4, Math.max(0.7, prof.rate + (punch > 0 ? 0.08 : punch < 0 ? -0.1 : 0)))
      if (i === 0) u.onstart = () => onstart?.()
      if (i === segments.length - 1) u.onend = () => onend?.()
      window.speechSynthesis.speak(u)
    })
  }

  /* Reveal stage: the AI introduces itself out loud, synced with the typewriter.
     The footer buttons only appear once the speech ends (onend) — with a
     watchdog fallback so a dropped onend never traps the user on the screen. */
  useEffect(() => {
    if (stage !== 4) return undefined
    setIntroDone(false)
    let fallback = 0
    /* Start talking almost immediately so the spoken intro keeps pace with the
       typewriter instead of arriving after the whole line is already on screen. */
    const timer = setTimeout(() => {
      speakLine(introLine, { onend: () => setIntroDone(true) })
      fallback = setTimeout(() => setIntroDone(true), 20000)
    }, 250)
    return () => { clearTimeout(timer); clearTimeout(fallback); window.speechSynthesis?.cancel() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  /* Final: hand the finished profile back to the app */
  const handleFinish = () => {
    stopPlayback()
    try { localStorage.removeItem(PROGRESS_KEY) } catch { /* private mode */ }
    const finishedUser = updatedUserRef.current
      || (name.trim() ? { ...userProfile, name: name.trim() } : null)
    /* Commit the chosen persona to the account too, so the voice picked here drives
       chat, tools and the live call across every device — not just this browser's
       localStorage (which is per-origin and dies on logout). Best-effort: the local
       ai_profile seed already carries this device if the call fails. */
    try {
      const token = loadSession()?.token
      if (token && character) {
        const persona = character.desc ? `${character.name} — ${character.desc}` : character.name
        updateProfile(token, { prefs: { assistantName: aiName.trim() || 'Aira', persona, gender: voiceGender } }).catch(() => {})
      }
    } catch { /* offline — the local seed still carries this device */ }
    onComplete(finishedUser)
  }

  return (
    <main className="onboarding-page">
      <header className="onboarding-progress">
        <div className="onboarding-track">
          <span className="onboarding-fill" style={{ width: `${progress}%` }} />
        </div>
        <ol className="onboarding-steps">
          {STEPS.map((label, index) => (
            <li key={label} className={index < stage + 1 ? 'done' : index === stage + 1 ? 'current' : ''}>
              <b>{index + 1}</b>
              <span>{label}</span>
            </li>
          ))}
        </ol>
      </header>

      <section className={`onboarding-body${stage === 4 ? ' reveal' : ''}`}>
        <div className="onboarding-copy">
          <h1 className="type-heading">
            {/* Invisible full text reserves the final height so typing never shifts the layout */}
            <span className="type-ghost" aria-hidden="true">
              {greeting.split('\n').map((line, index) => (
                <span key={`g${index}`}>
                  {index > 0 && <br />}
                  {line}
                </span>
              ))}
            </span>
            <span className="type-live">
              {typedLines.map((line, index) => (
                <span key={line + index}>
                  {index > 0 && <br />}
                  {line}
                </span>
              ))}
              <i className={`type-caret${typedCount >= greeting.length ? ' caret-done' : ''}`} aria-hidden="true" />
            </span>
          </h1>

          {stage === 0 && (
            <form className="onboarding-form" onSubmit={handleNameSubmit}>
              <label className="sr-only" htmlFor="call-name">Your name</label>
              <input
                id="call-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={`e.g. ${userProfile?.name || 'Alex'}`}
                maxLength={80}
                autoFocus
                disabled={saving}
              />
              <div className="form-actions">
                <button className="onboarding-continue" type="submit" disabled={!name.trim() || saving}>
                  {saving ? 'Saving…' : 'Continue'}
                </button>
              </div>
            </form>
          )}

          {stage === 1 && (
            <form className="onboarding-form" onSubmit={handleAiNameSubmit}>
              <label className="sr-only" htmlFor="ai-name">Assistant name</label>
              <input
                id="ai-name"
                value={aiName}
                onChange={(event) => setAiName(event.target.value)}
                placeholder="e.g. Nova, Jarvis, Kiwi…"
                maxLength={40}
                autoFocus
                disabled={saving}
              />
              <div className="form-actions">
                <button className="voice-back" type="button" onClick={() => { setName(''); setStage(0) }}>Back</button>
                <button className="onboarding-continue" type="submit" disabled={!aiName.trim() || saving}>
                  {saving ? 'Naming…' : 'Continue'}
                </button>
              </div>
            </form>
          )}

          {stage === 2 && (
            <div className="voice-block">
              <div className="voice-gender-toggle" role="group" aria-label="Voice gender">
                <button type="button" className={voiceGender === 'female' ? 'selected' : ''} onClick={() => changeGender('female')}>Female</button>
                <button type="button" className={voiceGender === 'male' ? 'selected' : ''} onClick={() => changeGender('male')}>Male</button>
              </div>
              <p className="voice-sub">Now pick a character. Click anywhere on a row to hear and select it.</p>
              <ul className="char-list">
                {CHARACTERS[voiceGender].map((char) => (
                  <li
                    key={char.id}
                    className={`pickable${character?.id === char.id ? ' picked' : ''}`}
                    onClick={() => previewVoice(char)}
                  >
                    <strong>{char.name}</strong>
                    <span>{char.desc}</span>
                    <button
                      type="button"
                      className={`char-play${playingId === char.id ? ' playing' : ''}`}
                      onClick={(event) => { event.stopPropagation(); previewVoice(char) }}
                      aria-label={`Hear ${char.name} voice`}
                    >
                      {playingId === char.id ? <WaveBars analyserRef={analyserRef} /> : <Icon name="play" size={13} />}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="browse-voices-section">
                <button type="button" className="browse-voices" onClick={() => fileInputRef.current?.click()}>
                  <span><Icon name="search" size={15} /></span> Browse voices from your device
                </button>
                <input ref={fileInputRef} type="file" accept="audio/*,video/*" multiple hidden onChange={handleFiles} />
                {naming ? (
                  <div className="name-voice-box">
                    <p>What do you want to name this voice?</p>
                    <input
                      value={voiceName}
                      onChange={(event) => setVoiceName(event.target.value)}
                      placeholder="e.g. Ammi, Sample lady, Rana…"
                      maxLength={40}
                      autoFocus
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveVoiceName() } }}
                    />
                    <div className="form-actions">
                      <button className="voice-back" type="button" onClick={askNextVoiceName}>Skip</button>
                      <button className="onboarding-continue" type="button" disabled={!voiceName.trim()} onClick={saveVoiceName}>Save voice</button>
                    </div>
                  </div>
                ) : customVoices.length > 0 && (
                  <ul className="char-list">
                    {customVoices.map((voice) => {
                      const tr = transcripts[voice.id]
                      return (
                        <li key={voice.id} className={`custom-voice${character?.id === voice.id ? ' picked' : ''}`}>
                          <strong>{voice.name}</strong>
                          {/* Words slot: behaves like the built-in voices' description text */}
                          <span className="voice-meta" title={tr?.text || ''}>
                            {tr?.status === 'listening'
                              ? (tr.text ? `“${tr.text}”…` : '🎙️ Scanning voice for words…')
                              : (tr?.text ? `“${tr.text}”` : 'Your device · custom voice')}
                          </span>
                          <div className="voice-actions">
                            <button
                              type="button"
                              className={`transcribe-btn${tr?.status === 'listening' ? ' listening' : ''}`}
                              onClick={() => (tr?.status === 'listening' ? stopPlayback() : transcribeVoice(voice))}
                            >
                              {tr?.status === 'listening' ? <><Icon name="record" size={12} /> Scanning…</> : <><Icon name="refresh" size={13} /> Re-scan</>}
                            </button>
                            <button
                              type="button"
                              className={`char-play${playingId === voice.id ? ' playing' : ''}`}
                              onClick={() => toggleFileVoice(voice)}
                              aria-label={playingId === voice.id ? `Stop ${voice.name}` : `Play ${voice.name}`}
                            >
                              {playingId === voice.id ? <WaveBars analyserRef={analyserRef} /> : <Icon name="play" size={13} />}
                            </button>
                          </div>
                          {tr && tr.status === 'error' && (
                            <p className="voice-words error">{tr.error}</p>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              {error && <p className="onboarding-error">{error}</p>}
              <div className="voice-footer">
                <button className="voice-back" type="button" onClick={() => setStage(1)}>Back</button>
                <button className="onboarding-continue" type="button" disabled={!character} onClick={handleVoiceContinue}>
                  Continue
                </button>
              </div>
            </div>
          )}

          {stage === 3 && (
            <div className="enroll-block">
              {enrollment.recording ? <>
                <div className="enroll-orb live" style={{ '--lvl': enrollment.level }} aria-hidden="true"><Icon name="mic" size={34} /></div>
                {enrollment.step < enrollment.lines.length ? <>
                  <p className="enroll-count">Line {enrollment.step + 1} / {enrollment.lines.length} - ye bol kar parhein</p>
                  <p className="enroll-line" aria-live="polite">"{enrollment.lines[enrollment.step]}"</p>
                  <div className="enroll-bar"><span style={{ width: `${Math.round(enrollment.progress * 100)}%` }} /></div>
                  {enrollment.note && <p className="enroll-note">{enrollment.note}</p>}
                </> : <p className="enroll-count">Aap ki awaaz yaad kar rahi hoon...</p>}
              </> : enrollment.record ? <>
                <div className="enroll-orb done" aria-hidden="true"><Icon name="check" size={34} /></div>
                <p className="enroll-line">Ho gaya, {enrollment.owner.split(' ')[0]}! Ab {enrollment.ai} sirf aap ki awaaz ke commands maanegi. Koi aur bolega to jawab milega: "Sorry, main sirf apne owner ki baat maanti hoon."</p>
              </> : <>
                <button type="button" className="enroll-orb" onClick={enrollment.enroll} aria-label="Start voice registration"><Icon name="mic" size={34} /></button>
                <p className="enroll-line">Jaise Siri sirf apne owner ki awaaz pe jaagti hai, waise hi {enrollment.ai} ko apni awaaz sikhaiye. Mic dabayein aur screen par aane wali 4 chhoti lines bol kar parhein (sirf 20 sec). Yeh ek basic awaaz-match hai, password jaisi pakki security nahi.</p>
              </>}
              {enrollment.error && <p className="onboarding-error">{enrollment.error}</p>}
              <div className="voice-footer">
                <button className="voice-back" type="button" disabled={enrollment.recording} onClick={() => setStage(2)}>Back</button>
                {enrollment.record
                  ? <button className="onboarding-continue" type="button" onClick={() => setStage(4)}>Continue</button>
                  : <button className="onboarding-continue ghost" type="button" disabled={enrollment.recording} onClick={() => {
                    /* Remember the choice so the workspace doesn't pop the same
                       "register your voice" card a few seconds later. */
                    try { sessionStorage.setItem('nexora_owner_voice_prompt', '0') } catch { /* private mode */ }
                    setStage(4)
                  }}>Skip for now</button>}
              </div>
            </div>
          )}

          {stage === 4 && (
            <div className="reveal-block">
              {/* Back pinned to the far left, the next action to the far right.
                  Space is reserved (visibility, not display) so the layout never
                  jumps — the row only becomes visible once the intro has played. */}
              <div className={`reveal-actions${introDone ? ' show' : ''}`}>
                <button className="voice-back" type="button" onClick={() => { window.speechSynthesis?.cancel(); setStage(3) }}>Back</button>
                <button className="onboarding-continue" type="button" onClick={handleFinish}>Enter Nexora</button>
              </div>
            </div>
          )}

          {error && stage === 0 && <p className="onboarding-error">{error}</p>}
        </div>

        <div className="onboarding-visual">
          {/* Particles morph: orb → the chosen gender portrait */}
          <NanoParticles count={30000} shape={particleShape} focusY={1.05} />
        </div>
      </section>
    </main>
  )
}
