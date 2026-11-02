import os from 'node:os'
import { execFile } from 'node:child_process'

/* System surface is intentionally tiny. There is NO unlock, NO credential
   handling, NO UAC bypass. `info` is read-only. `restart`/`shutdown` are the only
   power actions; the allowlist flags both alwaysConfirm, so they can never run
   without an explicit human approval, and the orchestrator additionally refuses
   them from free-text voice (see actions.js → fromVoice gate). */

const IS_WIN = process.platform === 'win32'

export function info() {
  return {
    platform: process.platform,
    release: os.release(),
    uptimeSeconds: Math.round(os.uptime()),
    hostname: os.hostname(),
    /* Whether the interactive desktop is usable. A locked console blocks UI
       automation (browser window, mouse/keyboard). We do not attempt to detect or
       — obviously — bypass the lock; we surface it so Aira can tell the user. */
    interactiveHint: IS_WIN
      ? 'If the PC is locked, launch/automation actions need an unlocked, active console session.'
      : 'non-Windows dev host',
  }
}

/* `shutdown`/`restart` accept a short grace delay so an accidental approval can
   be cancelled with the STOP (which runs `shutdown /a`). No command string ever
   reaches a shell — execFile with fixed argv only. */
function power(kind, delaySeconds) {
  return new Promise((resolve, reject) => {
    const delay = Math.max(5, Math.min(300, delaySeconds || 15))
    if (IS_WIN) {
      const flag = kind === 'restart' ? '/r' : '/s'
      execFile('shutdown', [flag, '/t', String(delay), '/c', `Nexora Aira ${kind} requested and confirmed`], (err) => {
        if (err) return reject(err)
        resolve({ scheduled: true, kind, inSeconds: delay, canCancelWith: 'STOP (runs shutdown /a) or "shutdown /a" in a terminal' })
      })
    } else {
      // Non-Windows is a dev/test box only; still fixed argv, no shell.
      const cmd = kind === 'restart' ? 'reboot' : 'poweroff'
      execFile('shutdown', ['-h', `+${Math.ceil(delay / 60)}`, cmd], (err) => {
        if (err) return reject(err)
        resolve({ scheduled: true, kind, inSeconds: delay })
      })
    }
  })
}

export function restart(_args, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('cancelled'))
  return power('restart', 15)
}

export function shutdown(_args, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('cancelled'))
  return power('shutdown', 15)
}

/* Called by the emergency STOP so a just-approved power action can be recalled. */
export function abortPower() {
  if (!IS_WIN) return Promise.resolve({ attempted: false })
  return new Promise((resolve) => {
    execFile('shutdown', ['/a'], (err) => resolve({ attempted: true, cancelled: !err, note: err ? 'nothing was scheduled' : 'scheduled power action cancelled' }))
  })
}

/* ── ARBITRARY COMMAND EXECUTION ─────────────────────────────────────────────
   The one genuinely open-ended capability, added on the owner's explicit request
   for full terminal access. It is deliberately NOT a silent path: the allowlist
   flags it `alwaysConfirm`, so NOTHING runs until a human approves the exact
   command string (the agent refuses execution without `approvedThisAction`).
   The runner still bounds it with a hard timeout and the emergency STOP kills it.
   Output is capped so a chatty command can't blow up the response. */
const OUTPUT_CAP = 20000

function cap(text) {
  const s = String(text || '')
  return s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n… (truncated ${s.length - OUTPUT_CAP} chars)` : s
}

export function runCommand(args, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('cancelled'))
  const command = String(args.command || '').trim()
  if (!command) return Promise.reject(new Error('No command to run.'))
  const timeoutMs = Math.max(1000, Math.min(120000, args.timeoutMs || 30000))
  /* Windows runs it through PowerShell; other hosts are dev/test boxes only. The
     command is passed as a single argv element to `-Command`/`-c`, never string-
     interpolated into another shell layer, so there is no extra quoting surface. */
  const argv = IS_WIN
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : ['-c', command]
  const shell = IS_WIN ? 'powershell.exe' : '/bin/sh'
  return new Promise((resolve, reject) => {
    const child = execFile(shell, argv, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (signal?.aborted) return reject(signal.reason || new Error('cancelled'))
        const timedOut = Boolean(err && err.signal === 'SIGTERM')
        const exitCode = typeof child.exitCode === 'number' ? child.exitCode : (err && !timedOut ? 1 : null)
        resolve({
          command,
          exitCode,
          ok: exitCode === 0,
          timedOut,
          stdout: cap(stdout),
          stderr: cap(stderr),
          note: timedOut ? `Timed out after ${timeoutMs}ms and was killed.` : undefined,
        })
      })
    signal?.addEventListener?.('abort', () => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
  })
}
