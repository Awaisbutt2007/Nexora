import { useEffect, useState } from 'react'
import {
  acquireVoiceTap, buildVoiceprint, capturePhrase, clearOwnerVoice, loadOwnerVoice,
  phraseSeconds, saveOwnerVoice, STRICTNESS, MIN_PHRASE_SECONDS,
} from './ownerVoice.js'
import { Icon } from './icons.jsx'

const PHRASE_MS = 5000

/* Lines the owner reads aloud. Mixed Roman Urdu + English on purpose: the print
   should cover the sounds the owner actually uses when giving commands. */
function enrollLines(owner, ai) {
  return [
    `Mera naam ${owner} hai, aur main ${ai} ka owner hoon.`,
    `${ai}, sirf meri awaaz pehchanna aur sirf meri baat maanna.`,
    'Aaj ka schedule bata do, aur mujhe ek reminder laga do.',
    'One, two, three, four, five — this is my real voice.',
  ]
}

/* Enroll / manage the owner's voiceprint. `compact` renders the first-run card
   shown in the workspace; otherwise it is the Settings group body. */
export default function OwnerVoiceSetup({ userKey, ownerName, aiName, compact = false, onDone }) {
  const [record, setRecord] = useState(() => loadOwnerVoice(userKey))
  const [step, setStep] = useState(-1) /* -1 idle, 0..n-1 recording line n, n = building */
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const owner = (ownerName || '').trim() || 'Owner'
  const ai = aiName || 'Aira'
  const lines = enrollLines(owner.split(/\s+/)[0], ai)

  useEffect(() => {
    const sync = () => setRecord(loadOwnerVoice(userKey))
    window.addEventListener('nexora-owner-voice', sync)
    return () => window.removeEventListener('nexora-owner-voice', sync)
  }, [userKey])

  async function enroll() {
    setError(''); setNote('')
    let release = null
    try {
      release = await acquireVoiceTap()
      const phrases = []
      for (let i = 0; i < lines.length; i += 1) {
        setStep(i); setProgress(0)
        const frames = await capturePhrase(PHRASE_MS, setProgress)
        if (phraseSeconds(frames) < MIN_PHRASE_SECONDS) {
          /* One quiet retry per line before giving up on it. */
          setNote('Thora aur zor se aur saaf boliye — same line dobara.')
          setProgress(0)
          const retry = await capturePhrase(PHRASE_MS, setProgress)
          phrases.push(retry)
        } else phrases.push(frames)
        setNote('')
      }
      setStep(lines.length)
      const print = buildVoiceprint(phrases)
      const next = { ...print, ownerName: owner, enabled: true, strictness: record?.strictness || 'normal', enrolledAt: new Date().toISOString() }
      saveOwnerVoice(userKey, next)
      setRecord(next)
      onDone?.(true)
    } catch (err) {
      setError(err?.name === 'NotAllowedError' ? 'Microphone permission was blocked. Allow it in the browser and try again.' : (err?.message || 'Could not record your voice.'))
    } finally {
      release?.()
      setStep(-1); setProgress(0)
    }
  }

  const update = (patch) => {
    const next = { ...record, ...patch }
    saveOwnerVoice(userKey, next)
    setRecord(next)
  }

  const recording = step >= 0

  if (recording) {
    return (
      <div className="settings-row owner-voice-recording" role="status" aria-live="polite">
        {step < lines.length ? <>
          <label>Line {step + 1} of {lines.length} — read this aloud</label>
          <p className="owner-voice-line">“{lines[step]}”</p>
          <div className="owner-voice-bar"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          {note && <span className="settings-hint">{note}</span>}
        </> : <p className="settings-hint">Building your voiceprint…</p>}
      </div>
    )
  }

  if (!record) {
    return (
      <div className="settings-row">
        <p className="settings-hint">
          Abhi {ai} har kisi ki awaaz par chal jati hai. Apni awaaz register karein — phir {ai} sirf {owner} ki awaaz wali voice commands maanegi, aur kisi aur ko bolegi: “Sorry, main sirf apne owner ki baat maanti hoon.”
        </p>
        <div className="settings-actions">
          <button className="settings-save" type="button" onClick={enroll}><Icon name="mic" size={14} /> Register my voice (20 sec)</button>
          {compact && <button className="settings-save ghost" type="button" onClick={() => onDone?.(false)}>Later</button>}
        </div>
        {error && <span className="settings-status err" role="alert">{error}</span>}
      </div>
    )
  }

  return <>
    <div className="settings-row">
      <label>Owner voice lock</label>
      <div className="settings-seg" role="group" aria-label="Owner voice lock">
        <button type="button" className={record.enabled !== false ? 'on' : ''} aria-pressed={record.enabled !== false} onClick={() => update({ enabled: true })}>On</button>
        <button type="button" className={record.enabled === false ? 'on' : ''} aria-pressed={record.enabled === false} onClick={() => update({ enabled: false })}>Off</button>
      </div>
      <span className="settings-hint">
        Registered for <b>{record.ownerName || owner}</b>. Voice commands from any other voice get a polite refusal. Typed chat is not affected.
      </span>
    </div>
    <div className="settings-row">
      <label htmlFor="owner-voice-strict">Strictness</label>
      <select id="owner-voice-strict" className="settings-select" value={record.strictness || 'normal'} onChange={(e) => update({ strictness: e.target.value })}>
        {Object.keys(STRICTNESS).map((k) => <option key={k} value={k}>{k === 'relaxed' ? 'Relaxed — fewer false refusals' : k === 'strict' ? 'Strict — refuse anything doubtful' : 'Normal'}</option>)}
      </select>
      <span className="settings-hint">If {ai} sometimes refuses YOU, re-record in your usual room/mic or pick Relaxed.</span>
    </div>
    <div className="settings-actions">
      <button className="settings-save" type="button" onClick={enroll}>Re-record my voice</button>
      <button className="settings-save ghost" type="button" onClick={() => { clearOwnerVoice(userKey); setRecord(null) }}>Remove voiceprint</button>
    </div>
    {error && <span className="settings-status err" role="alert">{error}</span>}
  </>
}
