import { useEffect, useState } from 'react'
import './InstallApp.css'

/* "Install app" — makes Nexora installable like a native app on every device.

   - Android / Windows / ChromeOS / Linux on Chrome or Edge: the browser fires
     `beforeinstallprompt`; we keep that event and replay it on click, which opens the
     browser's own one-tap install dialog.
   - iPhone / iPad (Safari, no install API): we show the two-step Share → Add to Home
     Screen instructions.
   - Mac Safari: File → Add to Dock. Mac Chrome/Edge get the real prompt above.
   - Anything without a one-tap prompt opens /download (DownloadPage.jsx), which lists
     every platform, the Windows setup .exe and step-by-step instructions.

   The event can fire before React mounts, so main.jsx stashes it on window first
   (captureInstallPrompt) and this component reads it from there. */

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

export function detectPlatform() {
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

/* Install button used on the landing page. Where the browser can install in one tap
   it does that; everywhere else it opens the /download page with every option. */
export function InstallAppButton({ className = 'button button-ghost button-large', label = 'Install app', alwaysShow = false }) {
  const { canPrompt, installed, prompt } = useInstallApp()
  if (installed && !alwaysShow) return null

  const onClick = async () => {
    if (canPrompt && await prompt()) return
    window.location.href = '/download'
  }

  return <button type="button" className={className} onClick={onClick}>
    <span className="install-icon" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
    </span>
    {label}
  </button>
}
