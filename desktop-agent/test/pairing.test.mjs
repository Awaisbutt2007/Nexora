import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createPairing } from '../src/pairing.js'
import { createApp } from '../src/index.js'

/* ── unit: pairing code + client-token store (no sockets) ─────────────────── */

test('pairing: currentCode is stable within its TTL and is 6 digits', () => {
  const p = createPairing({ pairCodeTtlMs: 60000, clientTokenTtlDays: 30 })
  const a = p.currentCode()
  const b = p.currentCode()
  assert.match(a.code, /^\d{6}$/)
  assert.equal(a.code, b.code, 'same code until it rotates')
})

test('pairing: verifyCode accepts the live code and rejects wrong / short ones', () => {
  const p = createPairing({ pairCodeTtlMs: 60000, clientTokenTtlDays: 30 })
  const { code } = p.currentCode()
  assert.equal(p.verifyCode(code), true)
  assert.equal(p.verifyCode(code === '000000' ? '000001' : '000000'), false)
  assert.equal(p.verifyCode('123'), false, 'short code rejected')
  assert.equal(p.verifyCode(''), false)
})

test('pairing: rotateCode invalidates the old code and mints a new one', () => {
  const p = createPairing({ pairCodeTtlMs: 60000, clientTokenTtlDays: 30 })
  const old = p.currentCode().code
  const fresh = p.rotateCode()
  assert.notEqual(fresh.code, undefined)
  assert.match(fresh.code, /^\d{6}$/)
  /* What the test name promises: the old code stops working (unless the random draw
     happened to repeat it — a 1-in-a-million coincidence, not a regression). */
  if (fresh.code !== old) assert.equal(p.verifyCode(old), false, 'old pairing code is rejected after rotation')
  assert.equal(p.verifyCode(fresh.code), true, 'new pairing code is accepted')
})

test('pairing: issued token verifies, revokes, and only a hash is persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-pair-'))
  const p = createPairing({ pairCodeTtlMs: 60000, clientTokenTtlDays: 30, dataDir: dir })
  const { token } = p.issueToken({ userId: 'usr_1', email: 'a@b.test', plan: 'monthly_pro' })
  assert.match(token, /^nexora_[0-9a-f]{48}$/)
  assert.equal(p.verifyToken(token)?.userId, 'usr_1')
  assert.equal(p.verifyToken('nexora_' + '0'.repeat(48)), null, 'unknown token rejected')
  // the on-disk store must never contain the plaintext token — only its hash
  const raw = fs.readFileSync(path.join(dir, 'client-tokens.json'), 'utf8')
  assert.ok(!raw.includes(token), 'plaintext token leaked to disk')
  assert.ok(raw.includes('tokenHash'))
  assert.equal(p.revokeToken(token), true)
  assert.equal(p.verifyToken(token), null, 'revoked token no longer verifies')
})

/* ── integration: HTTP pairing + origin gate + dual-mode auth ─────────────── */

let stub // mock cloud backend (entitlement) — no real network
let stubBase
let server
let BASE
let pairing
let secret
let pairedToken // handed by the PAID-pair test, consumed by the revoke test
const APP_ORIGIN = 'http://app.test'

function bearer(token, origin = APP_ORIGIN) {
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  if (origin) h.Origin = origin
  return h
}

before(async () => {
  // A stand-in for the cloud backend: it decides entitlement purely from the JWT.
  stub = http.createServer((req, res) => {
    const auth = req.headers.authorization || ''
    const t = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    res.setHeader('Content-Type', 'application/json')
    if (t === 'jwt-paid') return res.end(JSON.stringify({ ok: true, entitled: true, plan: 'monthly_pro', isPremium: true, userId: 'usr_paid', email: 'paid@x.test' }))
    if (t === 'jwt-free') return res.end(JSON.stringify({ ok: true, entitled: false, plan: 'free', isPremium: false, userId: 'usr_free', email: 'free@x.test' }))
    res.statusCode = 401
    res.end(JSON.stringify({ error: { message: 'Authentication required', type: 'auth_error' } }))
  })
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))
  stubBase = `http://127.0.0.1:${stub.address().port}`

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-agent-pair-it-'))
  secret = 'test-agent-secret-0123456789abcdef'
  const cfg = {
    host: '127.0.0.1', port: 0, nodeEnv: 'test', secret,
    actionTimeoutMs: 5000,
    allowedDirs: [sandbox], approvedAppIds: [], browser: 'headless chromium',
    browserProfileDir: path.join(sandbox, 'profile'), allowedHosts: [],
    auditDir: path.join(sandbox, 'audit'), dataDir: path.join(sandbox, 'data'), rootDir: sandbox,
    allowedOrigins: [APP_ORIGIN],
    backendUrl: stubBase,
    pairCodeTtlMs: 60000, pairWindowMs: 600000, clientTokenTtlDays: 30,
  }
  const created = createApp({ config: cfg })
  pairing = created.pairing
  await new Promise((r) => { server = created.app.listen(0, '127.0.0.1', r) })
  BASE = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise((r) => server.close(() => stub.close(r))))

test('GET /pair/status is reachable from an allowed Origin and leaks no code', async () => {
  const res = await fetch(`${BASE}/pair/status`, { headers: { Origin: APP_ORIGIN } })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.awaitingPair, true)
  assert.equal(j.entitlementRequired, true)
  assert.ok(!('code' in j), 'the pairing code must never be served over HTTP')
})

test('a disallowed browser Origin is refused with 403 origin_not_allowed', async () => {
  const res = await fetch(`${BASE}/permissions`, { headers: bearer(secret, 'http://evil.test') })
  assert.equal(res.status, 403)
  const j = await res.json()
  assert.equal(j.error.type, 'origin_not_allowed')
})

test('preflight OPTIONS for /pair answers 204 with the reflected Origin', async () => {
  const res = await fetch(`${BASE}/pair`, { method: 'OPTIONS', headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST' } })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN)
  assert.match(res.headers.get('access-control-allow-headers') || '', /Authorization/i)
})

test('pair with a wrong code → 403 bad_code (and the code is NOT consumed)', async () => {
  const live = pairing.currentCode().code
  const wrong = live === '000000' ? '000001' : '000000'
  const res = await fetch(`${BASE}/pair`, { method: 'POST', headers: bearer('', null), body: JSON.stringify({ code: wrong, jwt: 'jwt-paid' }) })
  // no Origin on a POST is fine for the gate, but send one like a browser would:
  const res2 = await fetch(`${BASE}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN }, body: JSON.stringify({ code: wrong, jwt: 'jwt-paid' }) })
  assert.equal(res2.status, 403)
  assert.equal((await res2.json()).error.type, 'bad_code')
  assert.equal(pairing.verifyCode(live), true, 'a failed attempt must not rotate the code')
  void res
})

test('pair with a valid code but a FREE account → 403 not_entitled', async () => {
  const code = pairing.currentCode().code
  const res = await fetch(`${BASE}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN }, body: JSON.stringify({ code, jwt: 'jwt-free' }) })
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.type, 'not_entitled')
})

test('pair with a valid code + PAID account → client token that drives a mutating route', async () => {
  const code = pairing.currentCode().code
  const res = await fetch(`${BASE}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN }, body: JSON.stringify({ code, jwt: 'jwt-paid' }) })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.ok, true)
  assert.match(j.token, /^nexora_[0-9a-f]{48}$/)
  assert.equal(j.user.plan, 'monthly_pro')
  // the token authenticates a read AND a mutating action, from the allowed Origin
  const perms = await fetch(`${BASE}/permissions`, { headers: bearer(j.token) })
  assert.equal(perms.status, 200)
  const plan = await fetch(`${BASE}/actions/plan`, { method: 'POST', headers: bearer(j.token), body: JSON.stringify({ action: 'system.info' }) })
  assert.equal(plan.status, 200)
  // a successful pair rotates the code, so the just-used code is now dead
  assert.equal(pairing.verifyCode(code), false)
  pairedToken = j.token
})

test('a revoked client token is refused (401) afterwards', async () => {
  const token = pairedToken
  assert.ok(token)
  const rev = await fetch(`${BASE}/pair/revoke`, { method: 'POST', headers: bearer(token) })
  assert.equal(rev.status, 200)
  const after = await fetch(`${BASE}/permissions`, { headers: bearer(token) })
  assert.equal(after.status, 401)
})

test('regression: the shared AGENT_SECRET still works over a no-Origin server call', async () => {
  const res = await fetch(`${BASE}/permissions`, { headers: { Authorization: `Bearer ${secret}` } })
  assert.equal(res.status, 200)
})

test('a client token presented from a disallowed Origin is refused', async () => {
  // re-pair to mint a live token, then try to use it from an evil origin
  const code = pairing.currentCode().code
  const j = await (await fetch(`${BASE}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN }, body: JSON.stringify({ code, jwt: 'jwt-paid' }) })).json()
  const res = await fetch(`${BASE}/permissions`, { headers: bearer(j.token, 'http://evil.test') })
  assert.equal(res.status, 403)
})
