/* Mobile browsers only let a page make sound after the user has touched it, and
   iOS Safari is stricter still: speechSynthesis stays muted for the whole page
   session unless its FIRST speak() call happens inside a tap/click handler. The
   AI reply is spoken seconds later from a network callback, which is never a
   gesture, so on phones the reply stayed silent while desktop Chrome worked.

   Fix: on the very first tap / key press anywhere, speak a silent, empty
   utterance and play a silent audio clip. That unlocks both engines for the
   rest of the session, and also warms the voice list (Android/iOS load it
   lazily, and an empty list is what makes the first reply pick no voice). */

const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
const EVENTS = ['pointerdown', 'touchend', 'click', 'keydown']
let unlocked = false

function unlock() {
  if (unlocked) return
  unlocked = true
  EVENTS.forEach((e) => window.removeEventListener(e, unlock, true))
  try {
    const eng = window.speechSynthesis
    if (eng) {
      eng.getVoices()
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0
      eng.speak(u)
    }
  } catch { /* no engine — nothing to unlock */ }
  try {
    const a = new window.Audio(SILENT_WAV)
    a.volume = 0
    const p = a.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch { /* ignore */ }
}

export function installSpeechUnlock() {
  if (typeof window === 'undefined' || unlocked) return
  EVENTS.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }))
}

/** True on phones/tablets, where the desktop-only engine workarounds must not run. */
export function isMobileBrowser() {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
