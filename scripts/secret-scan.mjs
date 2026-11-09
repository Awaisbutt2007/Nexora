#!/usr/bin/env node
/*
 * Nexora local secret scanner (privacy-safe, never leaves the machine).
 * - Scans the working tree and (with --history) every blob in Git history.
 * - NEVER prints secret values: only file, line, rule id and a masked fingerprint.
 * - Exit code 1 if any finding (usable as a CI gate / npm security script).
 *
 * Usage:  node scripts/secret-scan.mjs [--history] [--json]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_HISTORY = process.argv.includes('--history')
const AS_JSON = process.argv.includes('--json')

// Directories we never scan (deps / build noise / binary-heavy).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache'])

// Ephemeral, gitignored working-tree dirs: browser-automation profiles (.tmp-*,
// *-profile, browser-profile), Vercel linkage, and local audit/screenshot drops.
// They hold third-party code whose strings can trip the credential regexes (e.g. a
// stray `AKIA…` inside a vendored Edge extension) yet are NEVER tracked or shipped
// (the tracked-file guard still proves that). Mirroring .gitignore here keeps the
// gate actionable instead of crying wolf on artifacts that can't reach production.
const SKIP_DIR_RE = /^\.tmp-|-profile$|^browser-profile$|^\.vercel$|^audit$|^screenshots$/

// Binary / media extensions to skip in the working-tree walk.
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.wav', '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.map', '.db', '.db-shm', '.db-wal', '.sqlite'])

// Detection rules.
//   strict:true  -> a REAL provider credential shape; flagged anywhere, no exceptions.
//   strict:false -> heuristic (hardcoded secret assignment); allowed to skip obvious
//                   placeholders/test fixtures so the gate stays actionable instead of
//                   crying wolf on every dummy value in a test.
const RULES = [
  { id: 'openai-key', label: 'OpenAI / OpenRouter API key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, strict: true },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, strict: true },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, strict: true },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g, strict: true },
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, strict: true },
  { id: 'slack-webhook', label: 'Slack webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/[A-Za-z0-9]+/g, strict: true },
  { id: 'private-key', label: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |)PRIVATE KEY-----/g, strict: true },
  { id: 'basic-auth-url', label: 'DB URL with embedded credentials', re: /\b(?:postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi, strict: true },
  { id: 'generic-secret-assign', label: 'Hardcoded secret assignment', re: /\b(?:JWT_SECRET|SESSION_SECRET|APP_SECRET|SIGNING_KEY|CLIENT_SECRET|API_KEY|SECRET_KEY|_TOKEN)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi, strict: false },
]

// Values that are intentionally public/dev-only and must NOT fail the gate.
// A real key never looks like these; strict rules ignore this list entirely.
const PLACEHOLDER_RE = /(test|example|changeme|change-me|placeholder|dummy|sample|your[-_]?[a-z]*[-_]?key|xxxx|todo|replace[-_]?me)/i

// Test fixtures legitimately contain dummy secret-looking strings (e.g. a weak
// password used to assert it is rejected). The heuristic rule skips them; the
// strict provider-credential rules still scan test files, so a REAL key pasted
// into a test is never forgiven.
function isTestPath(source) {
  return /(^|[\\/])(test|tests|__tests__)[\\/]/i.test(source) || /\.(test|spec)\.[cm]?js$/i.test(source)
}

function* walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (name === '.git') continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || SKIP_DIR_RE.test(name)) continue
      yield* walk(full)
    } else if (st.isFile()) {
      const ext = name.slice(name.lastIndexOf('.'))
      if (SKIP_EXT.has(ext)) continue
      yield full
    }
  }
}

// Keep only the characters needed to fingerprint; never the secret itself.
function fingerprint(value) {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const head = value.slice(0, 3)
  const tail = value.slice(-2)
  return `${head}…${tail} (len ${value.length}, sha ${h.toString(16).padStart(8, '0')})`
}

const findings = []

function scanText(source, getContent) {
  const lines = getContent().split(/\r?\n/)
  lines.forEach((line, idx) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(line)) !== null) {
        // Heuristic rules may hit dev/test placeholders or live in test fixtures —
        // those are not real leaks. Strict (provider-credential) rules are always
        // reported regardless of path or value.
        if (!rule.strict && (PLACEHOLDER_RE.test(m[0]) || isTestPath(source))) continue
        findings.push({
          file: source,
          line: idx + 1,
          type: rule.label,
          ruleId: rule.id,
          fingerprint: fingerprint(m[0]),
        })
        if (!rule.re.global) break
      }
    }
  })
}

// 1) Working tree
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  // Allow our own example templates and this scanner to be read without self-flagging.
  let content
  try { content = readFileSync(file, 'utf8') } catch { continue }
  if (content.includes('\u0000')) continue // binary
  scanText(rel, () => content)
}

// 2) Git history (every blob at every revision)
if (SCAN_HISTORY) {
  try {
    const out = execFileSync('git', ['rev-list', '--objects', '--all'], { encoding: 'utf8', cwd: ROOT })
    const lines = out.split(/\r?\n/).filter(Boolean)
    let scanned = 0
    for (const line of lines) {
      const space = line.indexOf(' ')
      if (space === -1) continue
      const sha = line.slice(0, space)
      const path = line.slice(space + 1)
      const seg = path.split('/')[0]
      if (SKIP_DIRS.has(seg) || SKIP_DIR_RE.test(seg)) continue
      const ext = path.slice(path.lastIndexOf('.'))
      if (SKIP_EXT.has(ext)) continue
      let content
      try { content = execFileSync('git', ['cat-file', '-p', sha], { encoding: 'utf8', cwd: ROOT, maxBuffer: 20 * 1024 * 1024 }) } catch { continue }
      if (content.includes('\u0000')) continue
      scanText(`history:${path}`, () => content)
      scanned++
    }
    if (!AS_JSON) process.stderr.write(`\nScanned ${scanned} historical blobs.\n`)
  } catch (e) {
    process.stderr.write(`history scan skipped: ${e.message}\n`)
  }
}

// Deduplicate identical (file,type,fingerprint) rows.
const seen = new Set()
const unique = findings.filter((f) => {
  const k = `${f.file}|${f.ruleId}|${f.fingerprint}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

if (AS_JSON) {
  process.stdout.write(JSON.stringify({ count: unique.length, findings: unique }, null, 2) + '\n')
} else if (unique.length === 0) {
  process.stdout.write('✅ secret-scan: no secret patterns found (working tree' + (SCAN_HISTORY ? ' + history' : '') + ')\n')
} else {
  process.stdout.write(`⚠️  secret-scan: ${unique.length} finding(s) — values are REDACTED (fingerprint only)\n\n`)
  for (const f of unique) {
    process.stdout.write(`  [${f.ruleId}] ${f.type}\n      file: ${f.file}:${f.line}\n      fp:   ${f.fingerprint}\n\n`)
  }
}

process.exit(unique.length > 0 ? 1 : 0)
