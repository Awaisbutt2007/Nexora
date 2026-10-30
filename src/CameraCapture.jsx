import { useEffect, useRef, useState } from 'react'
import './CameraCapture.css'

/* Live webcam capture for the chat composer. The 📷 button opens this: it asks the
   browser for camera access, shows the feed, and hands the chosen frame back as a
   File so the existing attach → upload → vision pipeline stays the single source of
   truth (this modal never talks to the network itself). Every getUserMedia track is
   stopped on close/flip so the camera light always goes off. */

/* Sequence for snapshot filenames — module scope so no render/handler reads
   Date.now()/Math.random() (react/purity). */
let shotSeq = 0

export default function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  /* 'user' = front/selfie camera (mirrored), 'environment' = back camera. */
  const [facing, setFacing] = useState('user')

  /* Acquire (and re-acquire when `facing` flips) the camera. The previous stream is
     torn down in the cleanup so a flip never stacks two live tracks and leaves the
     light on. All state writes happen in the async continuations — never synchronously
     in the effect body — so a flip can't cascade a redundant render. */
  useEffect(() => {
    let cancelled = false
    const md = navigator.mediaDevices
    const acquire = !md || typeof md.getUserMedia !== 'function'
      ? Promise.reject(Object.assign(new Error('getUserMedia unavailable'), { name: 'NotSupportedError' }))
      : md.getUserMedia({ video: { facingMode: facing }, audio: false })
    acquire
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => { /* autoplay guard — the frame still shows */ })
        }
        setReady(true)
      })
      .catch((err) => {
        if (cancelled) return
        const name = err && err.name
        setReady(false)
        setError(
          name === 'NotSupportedError'
            ? 'This browser can’t open a camera. A secure context (HTTPS or localhost) is required.'
            : name === 'NotAllowedError' || name === 'SecurityError'
              ? 'Camera permission was blocked. Allow it for this site in the browser, then reopen the camera.'
              : name === 'NotFoundError' || name === 'OverconstrainedError'
                ? 'No usable camera was found on this device.'
                : name === 'NotReadableError'
                  ? 'The camera is busy — close whatever else is using it and try again.'
                  : 'Could not start the camera.',
        )
      })
    return () => {
      cancelled = true
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null }
    }
  }, [facing])

  /* Escape closes; the effect teardown above stops the camera. */
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* Freeze the current frame to a JPEG File and hand it to the composer. Mirrored
     for the selfie camera so the shot matches what the user sees on screen. */
  function shoot() {
    const video = videoRef.current
    if (!video || !ready) return
    const w = video.videoWidth || 640
    const h = video.videoHeight || 480
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (facing === 'user') { ctx.translate(w, 0); ctx.scale(-1, 1) }
    ctx.drawImage(video, 0, 0, w, h)
    shotSeq += 1
    const seq = shotSeq
    canvas.toBlob((blob) => {
      if (!blob) { setError('Could not capture that frame.'); return }
      onCapture(new File([blob], `nexora-camera-${seq}.jpg`, { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.9)
  }

  return <div className="camera-overlay" role="dialog" aria-modal="true" aria-label="Take a photo"
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="camera-card">
      <div className="camera-head">
        <span className="camera-title">{error ? '📷 Camera unavailable' : '📷 Take a photo'}</span>
        <button type="button" className="camera-x" aria-label="Close camera" onClick={onClose}>×</button>
      </div>
      <div className={`camera-stage${facing === 'user' ? ' mirrored' : ''}`}>
        <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
        {!ready && !error && <div className="camera-hint">Allow camera access to take a photo…</div>}
        {error && <div className="camera-error" role="alert">{error}</div>}
      </div>
      <div className="camera-foot">
        <button type="button" className="camera-flip" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))} disabled={Boolean(error)} aria-label="Switch front or back camera">🔄 Flip</button>
        <button type="button" className="camera-shutter" onClick={shoot} disabled={!ready} aria-label="Capture photo"><span className="camera-shutter-ring" aria-hidden="true" /></button>
        <button type="button" className="camera-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  </div>
}
