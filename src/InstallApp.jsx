import { useEffect, useState } from 'react'
import './InstallApp.css'

/* "Install app" — makes Nexora installable like a native app on every device.

   - Android / Windows / ChromeOS / Linux on Chrome or Edge: the browser fires
     `beforeinstallprompt`; we keep that event and replay it on click, which opens the
     browser's own one-tap install dialog.
   - iPhone / iPad (Safari, no install API): we show the two-step Share → Add to Home
     Screen instructions.
   - Mac Safari: File → Add to Dock. Mac Chrome/Edge get the real prompt above.
   - Windows without a prompt (Firefox, or prompt already used): offer the Windows
     setup .exe that lives in /downloads.

   The event can fire before React mounts, so main.jsx stashes it on window first
   (captureInstallPrompt) and this component reads it from there. */

const EXE_URL = '/downloads/Nexora-Setup.exe'

export function captureInstallPrompt() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    window.__nexoraInstallPrompt = e
    window.dispatchEvent(new Event('nexora:installable'))
  })
  window.addEventListener('appinstalled', () => {
    window.__nexoraInstallPrompt = null
    window.dispatchEvent(new Event('nexora:installed'))
  })
}

function isInstalled() {
  if (typeof window === 'undefined') return false
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: window-controls-overlay)').matches
    || window.navigator.standalone,
  )
}

function detectPlatform() {
  const ua = navigator.userAgent || ''
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (iOS) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/.test(ua)) return /Chrome|Edg\//.test(ua) ? 'mac-chromium' : 'mac-safari'
  if (/Windows/i.test(ua)) return 'windows'
  return 'other'
}

export function useInstallApp() {
  const [canPrompt, setCanPrompt] = useState(() => typeof window !== 'undefined' && Boolean(window.__nexoraInstallPrompt))
  const [installed, setInstalled] = useState(isInstalled)

  useEffect(() => {
    const onReady = () => setCanPrompt(Boolean(window.__nexoraInstallPrompt))
    const onDone = () => { setInstalled(true); setCanPrompt(false) }
    window.addEventListener('nexora:installable', onReady)
    window.addEventListener('nexora:installed', onDone)
    return () => {
      window.removeEventListener('nexora:installable', onReady)
      window.removeEventListener('nexora:installed', onDone)
    }
  }, [])

  const prompt = async () => {
    const e = window.__nexoraInstallPrompt
    if (!e) return false
    e.prompt()
    try {
      const choice = await e.userChoice
      if (choice?.outcome === 'accepted') setInstalled(true)
    } catch { /* ignore */ }
    window.__nexoraInstallPrompt = null
    setCanPrompt(false)
    return true
  }

  return { canPrompt, installed, prompt }
}

function Steps({ platform }) {
  if (platform === 'ios') {
    return <ol className="install-steps">
      <li>Open this page in <b>Safari</b>.</li>
      <li>Tap the <b>Share</b> button <span className="install-glyph" aria-hidden="true">⬆</span> at the bottom.</li>
      <li>Choose <b>Add to Home Screen</b>, then tap <b>Add</b>.</li>
    </ol>
  }
  if (platform === 'mac-safari') {
    return <ol className="install-steps">
      <li>In Safari, open the <b>File</b> menu (or the Share button).</li>
      <li>Choose <b>Add to Dock</b>, then click <b>Add</b>.</li>
    </ol>
  }
  if (platform === 'android') {
    return <ol className="install-steps">
      <li>Open this page in <b>Chrome</b>.</li>
      <li>Tap the menu <b>⋮</b> at the top right.</li>
      <li>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</li>
    </ol>
  }
  return <ol className="install-steps">
    <li>Open this page in <b>Chrome</b> or <b>Edge</b>.</li>
    <li>Click the install icon in the address bar, or menu → <b>Install Nexora</b>.</li>
  </ol>
}

export function InstallAppButton({ className = 'button button-ghost button-large', label = 'Install app' }) {
  const { canPrompt, installed, prompt } = useInstallApp()
  const [open, setOpen] = useState(false)
  const [platform] = useState(() => (typeof navigator === 'undefined' ? 'other' : detectPlatform()))

  if (installed) return null

  const onClick = async () => {
    if (canPrompt && await prompt()) return
    setOpen(true)
  }

  return <>
    <button type="button" className={className} onClick={onClick}>
      <span className="install-icon" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
      </span>
      {label}
    </button>
    {open && <div className="install-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <div className="install-sheet" role="dialog" aria-modal="true" aria-labelledby="install-title" onClick={(e) => e.stopPropagation()}>
        <div className="install-head">
          <img src="/pwa-icon-192.png" alt="" width="48" height="48" />
          <div>
            <h3 id="install-title">Install Nexora</h3>
            <p>Opens in its own window, with its own icon — just like an app.</p>
          </div>
        </div>
        <Steps platform={platform} />
        {platform === 'windows' && <a className="install-exe" href={EXE_URL} download>
          Or download the Windows setup (.exe)
        </a>}
        <button type="button" className="install-close" onClick={() => setOpen(false)}>Got it</button>
      </div>
    </div>}
  </>
}
