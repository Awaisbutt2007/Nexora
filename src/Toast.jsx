import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'

/* Animated notification toast: springs in from the right, the icon pops, a light
   sheen sweeps across once, a progress bar drains over the toast's lifetime, and
   it slides back out instead of vanishing. The tone (success / error / memory /
   info) is read from the message so colour and icon match what happened. */

const LIFETIME_MS = 6000
const EXIT_MS = 320

function toneOf(text) {
  const t = String(text || '').toLowerCase()
  if (/could not|couldn't|failed|error|not available|invalid|denied|try again|out of credit|busy/.test(t)) return 'error'
  if (/remember|memory|memories/.test(t)) return 'memory'
  if (/replied|saved|updated|done|added|deleted|copied|ready|welcome|success|stopped|paired/.test(t)) return 'success'
  return 'info'
}

const TONE_ICON = { success: 'check', error: 'warn', memory: 'brain', info: 'sparkle' }

export default function Toast({ text, onClose }) {
  /* Keep showing the last text while the exit animation plays. */
  const [shown, setShown] = useState(text)
  const [leaving, setLeaving] = useState(false)
  const [seq, setSeq] = useState(0)
  const lastText = useRef(text)

  useEffect(() => {
    if (text) {
      /* a new message replays the entrance + restarts the progress bar */
      const changed = text !== lastText.current || leaving
      lastText.current = text
      const id = setTimeout(() => {
        setShown(text)
        setLeaving(false)
        if (changed) setSeq((n) => n + 1)
      }, 0)
      return () => clearTimeout(id)
    }
    lastText.current = ''
    if (!shown) return undefined
    const start = setTimeout(() => setLeaving(true), 0)
    const id = setTimeout(() => { setShown(''); setLeaving(false) }, EXIT_MS)
    return () => { clearTimeout(start); clearTimeout(id) }
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null
  const tone = toneOf(shown)
  return (
    <div key={seq} className={`toast-message toast-${tone}${leaving ? ' toast-leaving' : ''}`} role="status" aria-live="polite">
      <span className="toast-icon"><Icon name={TONE_ICON[tone]} size={15} /></span>
      <span className="toast-text">{shown}</span>
      <button type="button" aria-label="Dismiss notification" onClick={onClose}><Icon name="cross" size={14} /></button>
      <i className="toast-progress" style={{ animationDuration: `${LIFETIME_MS}ms` }} aria-hidden="true" />
    </div>
  )
}
