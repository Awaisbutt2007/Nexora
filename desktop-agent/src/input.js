import { runPS, isWindows, safeInt } from './pwsh.js'
import { getBounds } from './screen.js'

/* ────────────────────────────────────────────────────────────────────────────
   DESKTOP CONTROL — allowlisted mouse + keyboard on the user's own PC.

   There is NO way to run a shell command or type an arbitrary OS-level string
   here. The model may only PROPOSE one of these fixed verbs with strictly typed
   arguments; each coordinate is validated against the real screen before any
   click, and only ever reaches the desktop through execFile → PowerShell with
   fixed argv and integers spliced in (never a model-supplied command).

   Safety posture (enforced in allowlist.js, mirrored by the UI):
   • The whole `desktop` scope is default-deny; nothing moves until it is granted.
   • Typing text and pressing key combinations are `alwaysConfirm` — because typed
     text can post a message / submit a form, they need a fresh approval every
     single time, even with the scope on. Text is treated as SECRET (never logged).
   • Key combos come from the fixed SAFE_KEYS set. There is deliberately no
     Win-key / Ctrl+Alt+Del / UAC surface — SendKeys cannot reach those, and we
     would never want it to.
   • The STOP runs in the same process tree; the runner aborts the child PowerShell
     between actions, so a stop is immediate rather than after a long script.
   ──────────────────────────────────────────────────────────────────────────── */

/* Named, reviewable key combinations → the SendKeys token that produces them. */
export const SAFE_KEYS = {
  'ctrl+c': '^c',
  'ctrl+v': '^v',
  'ctrl+x': '^x',
  'ctrl+z': '^z',
  'ctrl+a': '^a',
  'ctrl+f': '^f',
  'ctrl+s': '^s',
  'ctrl+shift+esc': '^+{ESC}',
  enter: '{ENTER}',
  escape: '{ESC}',
  tab: '{TAB}',
  'alt+tab': '%{TAB}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  space: ' ',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  f1: '{F1}',
  f5: '{F5}',
  'shift+f10': '+{F10}',
}

const CLICK_CODES = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
}

const INPUT_DECL = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type @"',
  'using System;using System.Runtime.InteropServices;',
  'public class NexoraInput{',
  ' [DllImport("user32.dll")]public static extern bool SetCursorPos(int X,int Y);',
  ' [DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,UIntPtr dwExtraInfo);',
  '}',
  '"@',
].join('\n')

async function assertOnScreen(x, y, signal) {
  const b = await getBounds({ signal })
  if (x < 0 || y < 0 || x >= b.width || y >= b.height) {
    throw new Error(`Coordinate (${x}, ${y}) is outside the screen (${b.width}×${b.height}).`)
  }
  return b
}

function needWindows() {
  if (!isWindows()) throw new Error('Desktop control requires a Windows desktop session.')
}

export async function move({ x, y }, { signal } = {}) {
  needWindows()
  const cx = safeInt(x, { min: 0, max: 30000, name: 'x' })
  const cy = safeInt(y, { min: 0, max: 30000, name: 'y' })
  await assertOnScreen(cx, cy, signal)
  await runPS(`${INPUT_DECL}\n[void][NexoraInput]::SetCursorPos(${cx},${cy})`, { timeoutMs: 12000, signal })
  return { moved: true, x: cx, y: cy }
}

export async function click({ x, y, button = 'left', double = false }, { signal } = {}) {
  needWindows()
  const cx = safeInt(x, { min: 0, max: 30000, name: 'x' })
  const cy = safeInt(y, { min: 0, max: 30000, name: 'y' })
  if (!CLICK_CODES[button]) throw new Error(`Mouse button "${button}" is not allowed.`)
  await assertOnScreen(cx, cy, signal)
  const { down, up } = CLICK_CODES[button]
  const one = `[NexoraInput]::mouse_event(${down},0,0,0,[UIntPtr]::Zero)\n[NexoraInput]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`
  const body = double ? `${one}\nStart-Sleep -Milliseconds 60\n${one}` : one
  await runPS(`${INPUT_DECL}\n[void][NexoraInput]::SetCursorPos(${cx},${cy})\n${body}`, { timeoutMs: 12000, signal })
  return { clicked: true, x: cx, y: cy, button, double: Boolean(double) }
}

export async function scroll({ x, y, direction = 'down', amount = 3 }, { signal } = {}) {
  needWindows()
  const amt = safeInt(amount, { min: 1, max: 25, name: 'amount' })
  // One notch is 120 wheel units in the low word of dwData; negative scrolls down.
  const delta = (direction === 'up' ? 1 : -1) * 120 * amt
  let prefix = INPUT_DECL
  if (Number.isInteger(x) && Number.isInteger(y)) {
    const cx = safeInt(x, { min: 0, max: 30000, name: 'x' })
    const cy = safeInt(y, { min: 0, max: 30000, name: 'y' })
    await assertOnScreen(cx, cy, signal)
    prefix += `\n[void][NexoraInput]::SetCursorPos(${cx},${cy})`
  }
  const script = `${prefix}\n[NexoraInput]::mouse_event(0x0800,0,0,[UInt32]([Int32]${delta}),[UIntPtr]::Zero)`
  await runPS(script, { timeoutMs: 12000, signal })
  return { scrolled: true, direction, amount: amt }
}

/* Escape a literal string for SendKeys (wrap each special in braces), then make it
   safe to embed in a single-quoted PowerShell literal. */
function sendKeysLiteral(raw) {
  const escaped = String(raw).replace(/([+^%~(){}[\]])/g, '{$1}')
  return escaped.replace(/'/g, "''")
}

export async function type({ text }, { signal } = {}) {
  needWindows()
  const value = String(text ?? '')
  if (!value.length) throw new Error('Nothing to type.')
  if (value.length > 2000) throw new Error('Typed text is too long (max 2000 characters).')
  // Reject control characters outright — an embedded Enter/Tab could submit or
  // navigate, which belongs in an explicit desktop.key, not silent typed text.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new Error('Typed text may not contain control characters.')
  await runPS(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('${sendKeysLiteral(value)}')`, { timeoutMs: 15000, signal })
  // Never echo the typed text back — it may be a password or private input.
  return { typed: true, characters: value.length }
}

export async function key({ combo }, { signal } = {}) {
  needWindows()
  const token = SAFE_KEYS[combo]
  if (token === undefined) throw new Error(`Key combination "${combo}" is not in the safe list.`)
  await runPS(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('${token.replace(/'/g, "''")}')`, { timeoutMs: 12000, signal })
  return { pressed: combo }
}
