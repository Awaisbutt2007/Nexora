import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto'

/* Pairing + client-token layer for the "cloud web app + local agent" mode.
   The browser can no longer rely on the backend proxy (a cloud backend cannot reach
   this machine's loopback), so it drives the agent DIRECTLY. That needs a credential
   the browser holds — a per-install CLIENT TOKEN — and a safe way to hand it out:

   1. The agent shows a short numeric PAIRING CODE on its OWN console only. It is
      deliberately NOT served over HTTP, so a random site the user visits can never
      read it. The user types what they see into the app (out-of-band anchor).
   2. The app POSTs { code, jwt } to /pair. The agent verifies the code AND asks the
      cloud backend (outbound) whether that JWT is a real, paid account, before it
      mints anything. No valid paid account → no token.
   3. A successful pair returns a high-entropy client token (shown once). The browser
      stores it and presents it as Bearer on later calls. We persist only a SHA-256
      hash of the token, so the on-disk store is useless if leaked.

   The code rotates on a short TTL (a stale glance can't be reused) and tokens carry a
   bounded lifetime. This is separate from — and additive to — the shared AGENT_SECRET
   path the classic local-first backend proxy still uses. */

const DAY_MS = 86400000

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function createPairing(cfg = {}) {
  const codeTtlMs = Math.min(600000, Math.max(10000, Number(cfg.pairCodeTtlMs) || 60000))
  const tokenTtlMs = Math.max(1, Number(cfg.clientTokenTtlDays) || 30) * DAY_MS
  const file = cfg.dataDir ? path.join(cfg.dataDir, 'client-tokens.json') : null

  /* ── pairing code (console-only, rotates) ─────────────────────────────── */
  let code = null
  let codeExpiresAt = 0
  function currentCode() {
    const now = Date.now()
    if (!code || now >= codeExpiresAt) {
      code = String(randomInt(0, 1000000)).padStart(6, '0')
      codeExpiresAt = now + codeTtlMs
    }
    return { code, expiresInMs: Math.max(0, codeExpiresAt - Date.now()) }
  }
  function rotateCode() { code = null; return currentCode() }
  function verifyCode(input) {
    if (!code) currentCode()
    if (Date.now() >= codeExpiresAt) return false // expired — a fresh code is needed
    const given = String(input || '').trim()
    if (given.length !== 6) return false
    const a = Buffer.from(given)
    const b = Buffer.from(code)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /* ── client tokens (hashed at rest) ───────────────────────────────────── */
  let tokens = loadTokens()
  function loadTokens() {
    if (!file) return []
    try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(raw) ? raw : [] } catch { return [] }
  }
  function saveTokens() {
    if (!file) return
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(tokens, null, 2)) } catch { /* in-memory if disk unavailable */ }
  }
  function prune() {
    const now = Date.now()
    const before = tokens.length
    tokens = tokens.filter((t) => t.expiresAt > now)
    if (tokens.length !== before) saveTokens()
  }

  function issueToken(user) {
    prune()
    const token = `nexora_${randomBytes(24).toString('hex')}`
    const rec = {
      tokenHash: hashToken(token),
      userId: user.userId,
      email: user.email || null,
      plan: user.plan || 'free',
      createdAt: Date.now(),
      expiresAt: Date.now() + tokenTtlMs,
    }
    tokens.push(rec)
    saveTokens()
    return { token, expiresAt: rec.expiresAt }
  }

  function verifyToken(token) {
    if (!token) return null
    prune()
    const h = hashToken(token)
    const rec = tokens.find((t) => t.tokenHash === h && t.expiresAt > Date.now())
    return rec || null
  }

  function revokeToken(token) {
    const h = hashToken(token)
    const before = tokens.length
    tokens = tokens.filter((t) => t.tokenHash !== h)
    saveTokens()
    return tokens.length < before
  }

  function tokenCount() { prune(); return tokens.length }

  return { currentCode, rotateCode, verifyCode, issueToken, verifyToken, revokeToken, tokenCount }
}

export default createPairing
