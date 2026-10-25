import { execFile } from 'node:child_process'

/* ────────────────────────────────────────────────────────────────────────────
   A tiny, disciplined PowerShell bridge.

   WHY PowerShell and not robotjs / nut-js: this project runs on Node 24 on
   Windows. robotjs (0.9.1, unmaintained) and the nut-js native bindings must be
   COMPILED from source against the current Node ABI via node-gyp, which fails
   without a full Visual Studio toolchain and is fragile even with one. The spec
   says to verify compatibility or pick a maintained Windows-compatible
   alternative — the evergreen, always-present Windows automation surface here is
   .NET itself (System.Drawing for capture, user32.dll + SendKeys for input),
   reached through PowerShell. That needs ZERO native npm builds.

   Security invariants (mirror system.js / apps.js — the model never steers this):
   • execFile, never a shell. The argv is FIXED; only `-EncodedCommand <base64>`
     carries the script, so there is no quoting/escaping bug to inject through.
   • The script text is always an INTERNAL constant assembled by JS. The ONLY
     values spliced in are strictly validated first — integers for coordinates and
     sizes, and identifiers matched against /^[A-Za-z0-9_-]+$/. A model-supplied
     string is never concatenated into a script (see input.js / screen.js).
   • Every call is bounded by a timeout and honourable via an AbortSignal, so the
     emergency STOP actually kills a hung capture instead of leaking the child.
   ──────────────────────────────────────────────────────────────────────────── */

const IS_WIN = process.platform === 'win32'
const POWERSHELL = 'powershell.exe'

export function isWindows() {
  return IS_WIN
}

/* Run an INTERNAL PowerShell script and resolve with trimmed stdout. `opts.signal`
   lets the runner's timeout / STOP kill the child process. */
export function runPS(script, { timeoutMs = 20000, signal } = {}) {
  if (!IS_WIN) {
    return Promise.reject(new Error('Desktop control and screen observation are only supported on a Windows desktop session.'))
  }
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('cancelled'))

  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (signal?.aborted) return reject(signal.reason || new Error('cancelled'))
        if (err) return reject(new Error(`PowerShell step failed: ${err.message}`))
        resolve(String(stdout || '').trim())
      },
    )
    signal?.addEventListener?.('abort', () => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
  })
}

/* Guard an identifier (screenshot name, app id fragment) before it is ever
   embedded into a script path. */
export function safeIdent(value, fallback) {
  const v = String(value ?? '').replace(/[^\w-]/g, '')
  return v || fallback
}

/* Reject anything that is not a finite integer inside [min,max]; return the clamped
   integer. Used for every coordinate, size and amount before it reaches a script. */
export function safeInt(value, { min, max, name }) {
  const n = Number(value)
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number.`)
  if (n < min || n > max) throw new Error(`${name} (${n}) is outside the allowed range ${min}–${max}.`)
  return n
}
