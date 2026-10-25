import fs from 'node:fs'
import path from 'node:path'
import { runPS, isWindows, safeIdent, safeInt } from './pwsh.js'

/* ────────────────────────────────────────────────────────────────────────────
   SCREEN OBSERVATION — capture the user's own desktop, on demand.

   Privacy rules baked in (the spec is explicit):
   • Nothing is captured until the "screen" scope is granted — enforced upstream
     by the permission gate; this module is only ever reached through it.
   • A capture is EPHEMERAL by default: the PNG/JPEG bytes are returned as an
     in-memory base64 data URL and NEVER written to disk. It is only saved when
     the caller passes save:true (an explicit user request), and then only under
     the agent's own screenshots/ folder with a sanitized name.
   • The bytes never go to the audit log — actions.js already drops result bodies.
   ──────────────────────────────────────────────────────────────────────────── */

let boundsCache = null // { width, height, at }
const BOUNDS_TTL_MS = 15_000

/* The full screen geometry, used to validate every coordinate before an input
   action runs. Cached briefly; SetCursorPos/click use primary-screen pixel space. */
export async function getBounds({ signal } = {}) {
  if (boundsCache && Date.now() - boundsCache.at < BOUNDS_TTL_MS) return boundsCache
  const out = await runPS([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    'Write-Output ("{0} {1}" -f $s.Width, $s.Height)',
  ].join('\n'), { timeoutMs: 12000, signal })
  const m = /(\d+)\s+(\d+)/.exec(out)
  if (!m) throw new Error('Could not read the screen resolution.')
  boundsCache = { width: Number(m[1]), height: Number(m[2]), at: Date.now() }
  return boundsCache
}

/* Capture the primary screen. `maxWidth` downscales a big display so the JPEG
   stays small enough to hand to the vision model / return over the bridge. */
export async function capture({ maxWidth = 1920, save = false, name, screenshotDir, signal } = {}) {
  if (!isWindows()) throw new Error('Screen observation requires a Windows desktop session.')

  const w = safeInt(maxWidth, { min: 640, max: 3840, name: 'maxWidth' })

  let savePath = null
  if (save) {
    if (!screenshotDir) throw new Error('No screenshots directory configured for saving.')
    const file = path.join(screenshotDir, `${safeIdent(name, `screen-${Date.now()}`)}.jpg`)
    // Only ever write inside the agent's own screenshots dir.
    if (path.dirname(file) !== path.resolve(screenshotDir)) throw new Error('Refusing to save the screenshot outside the agent folder.')
    fs.mkdirSync(screenshotDir, { recursive: true })
    savePath = file
  }

  // Build the INTERNAL script. The only spliced values are the validated integer
  // `w` and an optionally single-quoted absolute path we constructed ourselves.
  const lines = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp=New-Object System.Drawing.Bitmap $s.Width, $s.Height',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($s.X, $s.Y, 0, 0, $bmp.Size)',
    '$g.Dispose()',
    `$maxw=${w}`,
    '$cw=$bmp.Width; $ch=$bmp.Height',
    'if ($maxw -gt 0 -and $cw -gt $maxw) { $nw=$maxw; $nh=[int][Math]::Round($ch*($maxw/$cw)); $nb=New-Object System.Drawing.Bitmap $nw,$nh; $ng=[System.Drawing.Graphics]::FromImage($nb); $ng.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $ng.DrawImage($bmp,0,0,$nw,$nh); $ng.Dispose(); $bmp.Dispose(); $bmp=$nb; $cw=$nw; $ch=$nh }',
    '$ms=New-Object System.IO.MemoryStream',
    '$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg)',
    '$bytes=$ms.ToArray(); $ms.Dispose(); $bmp.Dispose()',
  ]
  if (savePath) lines.push(`[System.IO.File]::WriteAllBytes('${savePath.replace(/'/g, "''")}', $bytes)`)
  lines.push(
    `$meta=@{width=$cw;height=$ch;bytes=$bytes.Length;saved=$(if (${save ? '$true' : '$false'}) {'__SAVED__'} else {$null})}|ConvertTo-Json -Compress`,
    'Write-Output $meta',
    'Write-Output ([Convert]::ToBase64String($bytes))',
  )
  let script = lines.join('\n')
  if (savePath) script = script.replace('__SAVED__', `'${savePath.replace(/'/g, "''")}'`)

  const out = await runPS(script, { timeoutMs: 25000, signal })
  const nl = out.indexOf('\n')
  if (nl === -1) throw new Error('Screen capture returned no data.')
  let meta
  try { meta = JSON.parse(out.slice(0, nl)) } catch { throw new Error('Screen capture produced an unreadable header.') }
  const b64 = out.slice(nl + 1).replace(/\s+/g, '')
  if (!b64) throw new Error('Screen capture produced an empty image.')

  return {
    width: meta.width,
    height: meta.height,
    bytes: meta.bytes,
    saved: meta.saved || null, // null unless the user explicitly asked to save
    format: 'image/jpeg',
    /* Returned to the (authenticated, loopback) caller for an inline preview and
       the vision step. Never persisted, never logged. */
    dataUrl: `data:image/jpeg;base64,${b64}`,
  }
}
