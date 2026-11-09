import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Nexora from './Nexora.jsx'
import DownloadPage from './DownloadPage.jsx'
import { captureInstallPrompt } from './InstallApp.jsx'
import { installSpeechUnlock } from './speechUnlock.js'

/* Catch the browser's install offer before React mounts (it can fire very early). */
captureInstallPrompt()
/* Phones mute speech until a tap has "unlocked" it — arm that before anything renders. */
installSpeechUnlock()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/^\/download\/?$/.test(window.location.pathname) ? <DownloadPage /> : <Nexora />}
  </StrictMode>,
)

/* Register the service worker so Nexora is installable and its shell works offline.
   Production only — in dev Vite hot-reloads and a cached shell would fight it. The
   worker never touches /api or /uploads, so a signed-in user's data is never cached.
   Failures are swallowed: a blocked/unavailable SW just means a normal website, not a
   broken one. */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
