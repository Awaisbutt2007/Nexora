/* Nexora backend integration tests — Node's built-in runner, zero extra deps.
   Run:  npm test   (from backend/)  or  npm run test:api  (from repo root)

   Isolated & deterministic by design:
     - throwaway SQLite file in the OS temp dir (never touches data/nexora.db)
     - OPENAI_API_KEY forced empty → mock mode → no network, no paid usage
     - auth rate buckets raised → functional tests can't trip the brute-force guard
   Every env value is set BEFORE the app module is imported so config.js reads it. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_DB = path.join(os.tmpdir(), `nexora-test-${process.pid}-${Date.now()}.db`)
process.env.NODE_ENV = 'test'
process.env.DB_PATH = TEST_DB
process.env.OPENAI_API_KEY = ''
process.env.JWT_SECRET = 'nexora-test-secret'
process.env.CORS_ORIGIN = 'http://localhost:5173'
process.env.AUTH_RATE_LIMIT = '1000'
process.env.AUTH_IP_RATE_LIMIT = '1000'
process.env.AI_RATE_LIMIT_PER_MIN = '1000'
process.env.FREE_MONTHLY_CREDITS = '5000'
/* Pin strict auth so the contract below is the real one; the open demo mode
   (default ON in dev) is exercised separately via a runtime config toggle. */
process.env.AUTH_OPEN_MODE = '0'
/* One-process mode: point the hosted-client folder at a throwaway "build" so `GET /` can
   be asserted to serve the APP (not the API docs) from the same origin as /api. */
const TEST_CLIENT = path.join(os.tmpdir(), `nexora-client-${process.pid}`)
fs.mkdirSync(path.join(TEST_CLIENT, 'assets'), { recursive: true })
fs.writeFileSync(path.join(TEST_CLIENT, 'index.html'), '<!doctype html><title>Nexora test shell</title>')
fs.writeFileSync(path.join(TEST_CLIENT, 'assets', 'shell.js'), 'console.log(1)')
process.env.CLIENT_DIR = TEST_CLIENT

let server
let BASE
let dbHandle

before(async () => {
  const { app } = await import('../src/index.js')
  const { getDb } = await import('../src/db/index.js')
  dbHandle = getDb()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  BASE = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  /* Close the SQLite handle first so Windows releases the file lock, then clean
     the throwaway DB. Best-effort: a lingering lock must never fail the run. */
  try { dbHandle?.close() } catch { /* already closed */ }
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try { fs.rmSync(f, { force: true }) } catch { /* ignore locked temp file */ }
  }
  try { fs.rmSync(TEST_CLIENT, { recursive: true, force: true }) } catch { /* ignore */ }
})

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* SSE stream or empty body */ }
  return { status: res.status, headers: res.headers, json, text }
}

let seq = 0
const email = () => `t${Date.now()}-${(seq += 1)}@nexora.test`
async function newUser(name = 'Test User') {
  const e = email()
  const r = await api('POST', '/api/auth/register', { body: { name, email: e, password: 'secret123' } })
  return { token: r.json.token, email: e, user: r.json.user }
}

test('health reports mock mode (no key)', async () => {
  const r = await api('GET', '/health')
  assert.equal(r.status, 200)
  assert.equal(r.json.status, 'ok')
  assert.equal(r.json.ai, 'mock')
})

test('auth: register → duplicate → login ok → login bad', async () => {
  const e = email()
  const reg = await api('POST', '/api/auth/register', { body: { name: 'Ada', email: e, password: 'secret123' } })
  assert.equal(reg.status, 201)
  assert.ok(reg.json.token, 'register returns a token')
  assert.equal(reg.json.user.email, e.toLowerCase())

  assert.equal((await api('POST', '/api/auth/register', { body: { name: 'Ada', email: e, password: 'secret123' } })).status, 409)
  assert.equal((await api('POST', '/api/auth/login', { body: { email: e, password: 'secret123' } })).status, 200)

  const bad = await api('POST', '/api/auth/login', { body: { email: e, password: 'nope' } })
  assert.equal(bad.status, 401)
  assert.equal(bad.json.error.type, 'auth_error')
})

test('auth: open demo mode signs in ANY email/password and auto-provisions', async () => {
  const { config } = await import('../src/config.js')
  config.openAuth = true
  try {
    /* Unknown email → login IS the signup. */
    const e = email()
    const r = await api('POST', '/api/auth/login', { body: { email: e, password: 'x' } })
    assert.equal(r.status, 200)
    assert.ok(r.json.token, 'unknown email gets a real token')
    assert.equal(r.json.user.email, e.toLowerCase())
    const me = await api('GET', '/api/auth/me', { token: r.json.token })
    assert.equal(me.status, 200, 'the issued token works on protected routes')
    /* Existing account + wrong password → still let through. */
    const w = await api('POST', '/api/auth/login', { body: { email: e, password: 'totally-different' } })
    assert.equal(w.status, 200)
    /* Register skips format/length rules too. */
    const reg = await api('POST', '/api/auth/register', { body: { email: `p${Date.now()}`, password: '1' } })
    assert.equal(reg.status, 201)
    assert.ok(reg.json.user.name, 'name is derived from the email when omitted')
  } finally {
    config.openAuth = false
  }
})

test('auth never serializes the password hash', async () => {
  const { token } = await newUser()
  const me = await api('GET', '/api/auth/me', { token })
  assert.equal(me.status, 200)
  assert.ok(!('password' in me.json.user) && !('password_hash' in me.json.user))
})

test('billing: production blocks a free self-upgrade until a provider is configured, dev/test allow it', async () => {
  const { config } = await import('../src/config.js')
  const { token } = await newUser()
  try {
    /* Production with no payment provider: upgrades refused, downgrade to free allowed. */
    config.nodeEnv = 'production'
    config.paymentsEnabled = false
    const up = await api('POST', '/api/user/upgrade', { token, body: { plan: 'pro' } })
    assert.equal(up.status, 503, 'self-upgrade must be refused on an unbilled production server')
    assert.equal(up.json.error.type, 'payment_unavailable')
    const down = await api('POST', '/api/user/upgrade', { token, body: { plan: 'free' } })
    assert.equal(down.status, 200, 'downgrading to free is always allowed')
    /* Once a provider IS configured, the same upgrade succeeds. */
    config.paymentsEnabled = true
    const paid = await api('POST', '/api/user/upgrade', { token, body: { plan: 'pro' } })
    assert.equal(paid.status, 200)
    assert.equal(paid.json.user.isPremium, true)
  } finally {
    config.nodeEnv = 'test'
    config.paymentsEnabled = false
  }
})

test('billing: manual Easypaisa request → admin approve grants the plan to the requester', async () => {
  const { config } = await import('../src/config.js')
  const requester = await newUser('Payer')
  const admin = await newUser('Owner')
  const prev = { enabled: config.manualPaymentsEnabled, seller: config.seller, admins: config.adminUserIds }
  try {
    // Both endpoints need a token.
    assert.equal((await api('GET', '/api/billing/status')).status, 401)
    assert.equal((await api('POST', '/api/billing/request', { body: { plan: 'pro', method: 'easypaisa', txnId: 'ABC12345' } })).status, 401)

    // Payments disabled → a clear 503, never a silent plan change.
    config.manualPaymentsEnabled = false
    const off = await api('POST', '/api/billing/request', { token: requester.token, body: { plan: 'pro', method: 'easypaisa', txnId: 'ABC12345' } })
    assert.equal(off.status, 503)
    assert.equal(off.json.error.type, 'payment_unavailable')

    // Enable Easypaisa only, and make the owner an approver by EMAIL.
    config.seller = { accountName: 'Owner Store', easypaisa: '0300-1234567', jazzcash: '' }
    config.manualPaymentsEnabled = true
    config.adminUserIds = [admin.email]

    const status = await api('GET', '/api/billing/status', { token: requester.token })
    assert.equal(status.status, 200)
    assert.equal(status.json.isAdmin, false, 'a payer is not an approver')
    assert.equal(status.json.manualEnabled, true)
    assert.deepEqual(status.json.methods.map((m) => m.id), ['easypaisa'], 'only a configured wallet is offered')

    // Invalid: 'free' is not a requestable paid plan; unconfigured method; bad txn id.
    assert.equal((await api('POST', '/api/billing/request', { token: requester.token, body: { plan: 'free', method: 'easypaisa', txnId: 'ABC12345' } })).status, 400)
    assert.equal((await api('POST', '/api/billing/request', { token: requester.token, body: { plan: 'pro', method: 'jazzcash', txnId: 'ABC12345' } })).status, 400)
    assert.equal((await api('POST', '/api/billing/request', { token: requester.token, body: { plan: 'pro', method: 'easypaisa', txnId: 'bad tid!' } })).status, 400)

    // A valid request is stored pending and does NOT change the plan.
    const req = await api('POST', '/api/billing/request', { token: requester.token, body: { plan: 'pro', method: 'easypaisa', txnId: 'TX99887766' } })
    assert.equal(req.status, 201)
    assert.equal(req.json.request.status, 'pending')
    assert.equal((await api('GET', '/api/auth/me', { token: requester.token })).json.user.isPremium, false, 'requesting never grants premium')

    // A non-admin can neither list nor review.
    assert.equal((await api('GET', '/api/billing/requests', { token: requester.token })).status, 403)
    assert.equal((await api('POST', '/api/billing/review', { token: requester.token, body: { id: req.json.request.id, decision: 'approve' } })).status, 403)

    // The admin sees the pending row, joined to the payer's email.
    const list = await api('GET', '/api/billing/requests?status=pending', { token: admin.token })
    assert.equal(list.status, 200)
    assert.ok(list.json.data.some((r) => r.id === req.json.request.id && r.userEmail === requester.email))

    // Approving grants the plan to the REQUESTER (not the approver) and marks it.
    const ok = await api('POST', '/api/billing/review', { token: admin.token, body: { id: req.json.request.id, decision: 'approve' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.request.status, 'approved')
    const granted = await api('GET', '/api/auth/me', { token: requester.token })
    assert.equal(granted.json.user.isPremium, true)
    assert.equal(granted.json.user.plan, 'pro')
    assert.equal((await api('GET', '/api/auth/me', { token: admin.token })).json.user.isPremium, false, 'approving never upgrades the approver')

    // Reviewing an already-decided request is refused.
    assert.equal((await api('POST', '/api/billing/review', { token: admin.token, body: { id: req.json.request.id, decision: 'approve' } })).status, 409)
  } finally {
    config.manualPaymentsEnabled = prev.enabled
    config.seller = prev.seller
    config.adminUserIds = prev.admins
  }
})

test('billing: admin reject leaves the requester on their free plan', async () => {
  const { config } = await import('../src/config.js')
  const payer = await newUser('Payer2')
  const admin = await newUser('Owner2')
  const prev = { enabled: config.manualPaymentsEnabled, seller: config.seller, admins: config.adminUserIds }
  try {
    config.seller = { accountName: '', easypaisa: '', jazzcash: '0345-7654321' }
    config.manualPaymentsEnabled = true
    config.adminUserIds = [admin.user.id]
    const req = await api('POST', '/api/billing/request', { token: payer.token, body: { plan: 'yearly_pro', method: 'jazzcash', txnId: 'RV1234567' } })
    assert.equal(req.status, 201)
    const rej = await api('POST', '/api/billing/review', { token: admin.token, body: { id: req.json.request.id, decision: 'reject', note: 'no payment seen' } })
    assert.equal(rej.status, 200)
    assert.equal(rej.json.request.status, 'rejected')
    assert.equal((await api('GET', '/api/auth/me', { token: payer.token })).json.user.isPremium, false)
  } finally {
    config.manualPaymentsEnabled = prev.enabled
    config.seller = prev.seller
    config.adminUserIds = prev.admins
  }
})

test('protected routes reject missing / forged tokens', async () => {
  assert.equal((await api('GET', '/api/conversations')).status, 401)
  assert.equal((await api('GET', '/api/memory', { token: 'not.a.jwt' })).status, 401)
})

test('account: PATCH profile name reflects in /me', async () => {
  const { token } = await newUser('Old Name')
  const r = await api('PATCH', '/api/user/profile', { token, body: { name: 'New Name' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.user.name, 'New Name')
  assert.equal((await api('GET', '/api/auth/me', { token })).json.user.name, 'New Name')
})

test('account: companion prefs live on the user, merge key by key and survive a re-login', async () => {
  const { token, email: e } = await newUser('Prefs User')
  /* A brand-new account has saved nothing yet — the client reads {} and keeps its
     local defaults rather than seeing a null it has to guard against. */
  assert.deepEqual((await api('GET', '/api/auth/me', { token })).json.user.prefs, {})

  const first = await api('PATCH', '/api/user/profile', { token, body: { prefs: { language: 'ur', assistantName: 'Aira' } } })
  assert.equal(first.status, 200)
  assert.equal(first.json.user.prefs.language, 'ur')

  /* Second write sends only the name: the language must not be blanked. */
  const second = await api('PATCH', '/api/user/profile', { token, body: { prefs: { assistantName: 'Zara' } } })
  assert.equal(second.json.user.prefs.language, 'ur', 'prefs merge, they do not replace')
  assert.equal(second.json.user.prefs.assistantName, 'Zara')

  const again = await api('POST', '/api/auth/login', { body: { email: e, password: 'secret123' } })
  assert.equal(again.json.user.prefs.language, 'ur', 'the choice follows the account, not the browser')

  assert.equal((await api('PATCH', '/api/user/profile', { token, body: { prefs: { language: 'klingon' } } })).status, 400)
  assert.equal((await api('PATCH', '/api/user/profile', { token, body: { prefs: { apiKey: 'nope' } } })).status, 400, 'unknown keys are refused')
})

test('account: change email needs the current password, then only the new one logs in', async () => {
  const { token, email: oldEmail } = await newUser()
  const newEmail = email()
  assert.equal((await api('POST', '/api/auth/email', { token, body: { currentPassword: 'wrong', email: newEmail } })).status, 401)
  const ok = await api('POST', '/api/auth/email', { token, body: { currentPassword: 'secret123', email: newEmail } })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.user.email, newEmail.toLowerCase())
  assert.ok(ok.json.token, 'a fresh token is handed back')
  assert.equal((await api('POST', '/api/auth/login', { body: { email: newEmail, password: 'secret123' } })).status, 200)
  assert.equal((await api('POST', '/api/auth/login', { body: { email: oldEmail, password: 'secret123' } })).status, 401)
})

test('account: email change collides with an existing address (409)', async () => {
  const a = await newUser()
  const b = await newUser()
  const r = await api('POST', '/api/auth/email', { token: a.token, body: { currentPassword: 'secret123', email: b.email } })
  assert.equal(r.status, 409)
  assert.equal(r.json.error.type, 'conflict')
})

test('account: change password needs the current one, then the old stops working', async () => {
  const { token } = await newUser()
  assert.equal((await api('POST', '/api/auth/password', { token, body: { currentPassword: 'wrong', newPassword: 'brandnew1' } })).status, 401)
  const ok = await api('POST', '/api/auth/password', { token, body: { currentPassword: 'secret123', newPassword: 'brandnew1' } })
  assert.equal(ok.status, 200)
  const e = ok.json.user.email
  assert.equal((await api('POST', '/api/auth/login', { body: { email: e, password: 'secret123' } })).status, 401)
  assert.equal((await api('POST', '/api/auth/login', { body: { email: e, password: 'brandnew1' } })).status, 200)
})

/* Rotating a password must evict every older session (a stolen token is the whole
   reason someone changes it) while keeping the person who just proved the old
   password signed in via a freshly-minted token. JWT `iat` is second-granular, so
   advance the clock a full second to guarantee the stale token predates the floor. */
test('auth: changing the password revokes older tokens but the fresh one survives', async () => {
  const { token: oldToken, email: e } = await newUser()
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const ok = await api('POST', '/api/auth/password', { token: oldToken, body: { currentPassword: 'secret123', newPassword: 'brandnew1' } })
  assert.equal(ok.status, 200)
  assert.ok(ok.json.token, 'a fresh token is handed back so the current session survives')
  // The pre-rotation token is now dead against an authenticated route.
  assert.equal((await api('GET', '/api/auth/me', { token: oldToken })).status, 401)
  // The freshly-issued token still works and belongs to the same account.
  const me = await api('GET', '/api/auth/me', { token: ok.json.token })
  assert.equal(me.status, 200)
  assert.equal(me.json.user.email, e.toLowerCase())
})

test('chat streams SSE and terminates with [DONE]', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/chat/completions', { token, body: { message: 'Hello there', stream: true } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/event-stream/)
  assert.ok(r.headers.get('x-conversation-id'), 'conversation id exposed via header')
  assert.ok(r.text.includes('[DONE]'), 'stream terminates')
  assert.ok(/"delta"/.test(r.text), 'emits delta chunks')
})

test('clear image request returns the image proxy path (deterministic, no LLM)', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/chat/completions', { token, body: { message: 'generate an image of a red fox in snow', stream: true } })
  assert.ok(r.text.includes('/api/images/generate'), 'image proxy path present (token stays server-side)')
  assert.ok(r.text.includes('prompt='), 'prompt carried to the proxy')
})

test('adult image prompt is refused and builds no URL', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/chat/completions', { token, body: { message: 'make an image of a nude person', stream: true } })
  assert.match(r.text, /adult\/NSFW/i)
  assert.ok(!r.text.includes('/api/images/generate'), 'no image URL for NSFW')
})

test('remember… auto-saves a memory visible via GET /api/memory', async () => {
  const { token } = await newUser()
  const marker = 'TestRiversideFC'
  await api('POST', '/api/chat/completions', { token, body: { message: `remember that my favorite club is ${marker}`, stream: true } })
  const list = await api('GET', '/api/memory', { token })
  assert.equal(list.status, 200)
  assert.ok(list.json.data.some((m) => String(m.value).includes(marker)), 'auto-memory stored the fact')
})

test('credits are deducted after a chat', async () => {
  const { token, user } = await newUser()
  const start = user.creditsRemaining
  await api('POST', '/api/chat/completions', { token, body: { message: 'count my credits please', stream: true } })
  const me = await api('GET', '/api/auth/me', { token })
  assert.ok(me.json.user.creditsRemaining < start, 'balance went down')
})

test('image tool runs for real; NSFW is blocked', async () => {
  const { token } = await newUser()
  const ok = await api('POST', '/api/tools/image_generator/run', { token, body: { prompt: 'a serene mountain lake at dawn' } })
  assert.equal(ok.status, 201)
  assert.ok(ok.json.output.imageUrl.includes('/api/images/generate'))

  const bad = await api('POST', '/api/tools/image_generator/run', { token, body: { prompt: 'a nude portrait' } })
  assert.equal(bad.status, 201)
  assert.equal(bad.json.output.blocked, true)
  assert.equal(bad.json.output.imageUrl, null)
})

test('code tool returns a real model answer, not the TODO stub', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/tools/code_assistant/run', { token, body: { prompt: 'write a python function to reverse a string' } })
  assert.equal(r.status, 201)
  assert.equal(r.json.output.type, 'text')
  assert.ok(typeof r.json.output.answer === 'string' && r.json.output.answer.length > 0)
  assert.ok(!r.json.output.answer.includes('// TODO: implement'), 'no canned placeholder')
})

test('unknown tool id → 404', async () => {
  const { token } = await newUser()
  assert.equal((await api('POST', '/api/tools/nope/run', { token, body: { prompt: 'x' } })).status, 404)
})

test('cross-user access is denied (404) on conversations', async () => {
  const a = await newUser('Ann')
  const b = await newUser('Bob')
  const conv = await api('POST', '/api/conversations', { token: a.token, body: { title: 'Private' } })
  const cid = conv.json.id
  assert.equal((await api('GET', `/api/conversations/${cid}`, { token: b.token })).status, 404)
  assert.equal((await api('GET', `/api/conversations/${cid}`, { token: a.token })).status, 200)
})

test('conversations: delete-all clears only the caller threads', async () => {
  const a = await newUser('Ann')
  const b = await newUser('Bob')
  await api('POST', '/api/conversations', { token: a.token, body: { title: 'A1' } })
  await api('POST', '/api/conversations', { token: a.token, body: { title: 'A2' } })
  await api('POST', '/api/conversations', { token: b.token, body: { title: 'B1' } })
  const del = await api('DELETE', '/api/conversations', { token: a.token })
  assert.equal(del.status, 200)
  assert.equal(del.json.deleted, 2)
  assert.equal((await api('GET', '/api/conversations', { token: a.token })).json.data.length, 0)
  assert.equal((await api('GET', '/api/conversations', { token: b.token })).json.data.length, 1)
})

test('validation: bad body → structured 400 with no internals', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/conversations', { token, body: { title: 'x'.repeat(500) } })
  assert.equal(r.status, 400)
  assert.equal(r.json.error.type, 'invalid_request_error')
  assert.ok(!r.text.includes('node_modules'), 'no stack/paths in error body')
})

test('unknown route → clean 404 not_found', async () => {
  const { token } = await newUser()
  const r = await api('GET', '/api/does-not-exist', { token })
  assert.equal(r.status, 404)
  assert.equal(r.json.error.type, 'not_found')
})

/* ── Desktop agent bridge ──────────────────────────────────────────────────
   These run with DESKTOP_AGENT_SECRET unset (the test env never sets it), so
   they prove two things without needing a live agent: the proxy is behind
   requireAuth, and it fails CLOSED (503) rather than reaching for the network. */

test('desktop bridge: every route requires auth (401 without a token)', async () => {
  assert.equal((await api('GET', '/api/desktop/permissions')).status, 401)
  assert.equal((await api('POST', '/api/desktop/plan', { body: { action: 'system.info' } })).status, 401)
  assert.equal((await api('POST', '/api/desktop/execute', { body: { planId: 'x' } })).status, 401)
})

test('desktop bridge: fails closed when the shared secret is not set', async () => {
  const { token } = await newUser()
  const h = await api('GET', '/api/desktop/health', { token })
  assert.equal(h.status, 503)
  assert.equal(h.json.enabled, false, 'health reports the bridge OFF instead of faking a live agent')
  const g = await api('POST', '/api/desktop/permissions/grant', { token, body: { scope: 'files' } })
  assert.equal(g.status, 503)
  assert.equal(g.json.error.type, 'desktop_bridge_disabled')
  assert.ok(!/node_modules|at .*\.js:/.test(g.text), 'no internals in the disabled error')
})

test('desktop bridge: validates the NL intent request before calling the model (400)', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/desktop/intent', { token, body: { utterance: '' } })
  assert.equal(r.status, 400)
  assert.equal(r.json.error.type, 'invalid_request_error')
})

test('desktop bridge: screen capture + inspect require auth and fail closed (no live agent)', async () => {
  // No token → behind requireAuth.
  assert.equal((await api('POST', '/api/desktop/screen/capture')).status, 401)
  assert.equal((await api('POST', '/api/desktop/screen/inspect')).status, 401)
  const { token } = await newUser()
  // Authenticated but the bridge is disabled (no DESKTOP_AGENT_SECRET) → 503, and
  // nothing is ever written to disk because no capture actually runs.
  const c = await api('POST', '/api/desktop/screen/capture', { token })
  assert.equal(c.status, 503)
  assert.equal(c.json.error.type, 'desktop_bridge_disabled')
  const i = await api('POST', '/api/desktop/screen/inspect', { token, body: { question: 'what is on my screen' } })
  assert.equal(i.status, 503)
})

test('desktop bridge: the new screen/desktop scopes are valid (reach the agent, not a 400)', async () => {
  const { token } = await newUser()
  for (const scope of ['screen', 'desktop']) {
    const r = await api('POST', '/api/desktop/permissions/grant', { token, body: { scope } })
    assert.equal(r.status, 503, `${scope} is accepted; a disabled bridge is 503, not a validation 400`)
  }
  const bad = await api('POST', '/api/desktop/permissions/grant', { token, body: { scope: 'not-a-scope' } })
  assert.equal(bad.status, 400)
})

test('stream cancellation: a pre-aborted signal produces no deltas (mock mode)', async () => {
  const { streamChatCompletion } = await import('../src/services/ai.js')
  const c = new AbortController()
  c.abort()
  let count = 0
  for await (const _ch of streamChatCompletion({ history: [{ role: 'user', content: 'hi' }], signal: c.signal })) count++
  assert.equal(count, 0, 'an aborted stream must stop yielding immediately, not keep billing tokens')
})

/* ---- Pinned reply language: the code, not the prompt, has the last word ----
   A free-tier model told "MANDATORY: Urdu script" still answers a Roman-typed
   first message in Roman letters. These tests drive the guard with a fake stream
   factory so the retry path is proven without a provider or an API key. */

async function* toWords(text) {
  for (const w of text.split(/(\s+)/)) if (w) yield { content: w, model: 'test-model' }
  yield { content: '', model: 'test-model', usage: { total_tokens: 12 } }
}
const ROMAN_REPLY = 'Awais, bilkul! Maine aapki preferences yaad kar li hain.'
const URDU_REPLY = 'جناب، آپ کی ترجیحات محفوظ کر دی گئی ہیں۔'

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks.map((c) => c.content).join('')
}

test('language guard: a Roman attempt under a pinned Urdu setting is re-asked before the client sees it', async () => {
  const { guardedStream } = await import('../src/services/ai.js')
  const directives = []
  const open = (params) => { directives.push(params.extraDirective || null); return toWords(directives.length === 1 ? ROMAN_REPLY : URDU_REPLY) }
  const text = await drain(guardedStream({ language: 'ur', guard: true }, open))
  assert.equal(directives.length, 2, 'the wrong-script call is retried exactly once')
  assert.match(directives[1], /Urdu script/, 'the retry carries a corrective directive')
  assert.equal(text, URDU_REPLY, 'nothing from the failed attempt leaks to the client')
})

test('language guard: a reply in the right script streams live and is never re-asked', async () => {
  const { guardedStream } = await import('../src/services/ai.js')
  let calls = 0
  const open = () => { calls += 1; return toWords(URDU_REPLY) }
  const text = await drain(guardedStream({ language: 'ur', guard: true }, open))
  assert.equal(calls, 1, 'a correct Urdu answer costs one model call')
  assert.equal(text, URDU_REPLY)
})

test('language guard: a second wrong answer is still delivered — one retry, never a blank reply', async () => {
  const { guardedStream } = await import('../src/services/ai.js')
  let calls = 0
  const open = () => { calls += 1; return toWords(ROMAN_REPLY) }
  const text = await drain(guardedStream({ language: 'ur', guard: true }, open))
  assert.equal(calls, 2, 'the guard gives up after one retry instead of looping')
  assert.equal(text, ROMAN_REPLY, 'the user gets the imperfect answer rather than silence')
})

test('scriptViolation judges the script of a reply, not its words', async () => {
  const { scriptViolation } = await import('../src/services/ai.js')
  assert.equal(scriptViolation(ROMAN_REPLY, 'ur'), 'urdu', 'Roman letters under Urdu-first is a violation')
  assert.equal(scriptViolation(URDU_REPLY, 'ur'), null)
  assert.equal(scriptViolation('ٹھیک ہے main theek hoon', 'hinglish'), 'latin', 'Hinglish is Latin script by definition')
  assert.equal(scriptViolation('I am doing great, thanks!', 'en'), null)
  assert.equal(scriptViolation('main ekdum theek hoon', 'en'), null, 'Roman text is legal for English too — the guard only checks script')
  assert.equal(scriptViolation('kya chal raha hai', 'auto'), null, 'auto mirrors the user, so nothing is ever wrong')
  assert.equal(scriptViolation('A', 'ur'), null, 'too little to judge is never retried on a hunch')
})

/* ---- User-attached reference images (Ctrl+V / 📎 in the composer) ---- */

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function uploadOnePng(token) {
  const r = await api('POST', '/api/chat/images', { token, body: { dataUrl: PNG_1PX } })
  assert.equal(r.status, 201)
  assert.match(r.json.url, /^\/uploads\/img_[\w-]+\.png$/)
  return r.json.url
}

test('images: upload requires auth and rejects non-image data URLs', async () => {
  assert.equal((await api('POST', '/api/chat/images', { body: { dataUrl: PNG_1PX } })).status, 401)
  const { token } = await newUser()
  const bad = await api('POST', '/api/chat/images', { token, body: { dataUrl: 'data:text/plain;base64,SGVsbG8gd29ybGQh' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.type, 'invalid_request_error')
})

test('images: a stored upload is served back from /uploads with the right type', async () => {
  const { token } = await newUser()
  const url = await uploadOnePng(token)
  const res = await fetch(`${BASE}${url}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  const { config } = await import('../src/config.js')
  try { fs.rmSync(path.join(config.uploadsDir, url.split('/').pop()), { force: true }) } catch { /* best effort */ }
})

test('images: an image turn persists on the message and survives in history', async () => {
  const { token } = await newUser()
  const url = await uploadOnePng(token)
  const chat = await api('POST', '/api/chat/completions', { token, body: { message: 'what is in this image?', images: [url], stream: false } })
  assert.equal(chat.status, 200)
  assert.ok(chat.json.choices[0].message.content.length > 0, 'mock mode must still answer an image turn')
  const convo = await api('GET', `/api/conversations/${chat.json.conversationId}`, { token })
  const userMsg = convo.json.messages.find((m) => m.role === 'user')
  assert.deepEqual(userMsg.images, [url], 'GET conversation returns camelCase images, never raw images_json')
})

test('images: image-only turns are legal, empty turns are not', async () => {
  const { token } = await newUser()
  const url = await uploadOnePng(token)
  const only = await api('POST', '/api/chat/completions', { token, body: { images: [url], stream: false } })
  assert.equal(only.status, 200, 'a bare paste with no caption still reaches the model')
  const empty = await api('POST', '/api/chat/completions', { token, body: { stream: false } })
  assert.equal(empty.status, 400)
  assert.match(empty.json.error.message, /message or attach/i)
})

test('cors: local origins are reflected in dev, foreign origins never', async () => {
  const { config } = await import('../src/config.js')
  const acao = async (origin) => {
    const res = await fetch(`${BASE}/health`, { headers: { Origin: origin } })
    return res.headers.get('access-control-allow-origin')
  }
  assert.equal(await acao('http://localhost:5173'), 'http://localhost:5173', 'listed origin')
  assert.equal(await acao('http://localhost:6789'), 'http://localhost:6789', 'Vite rolled to a spare port')
  assert.equal(await acao('http://127.0.0.1:5173'), 'http://127.0.0.1:5173', 'loopback by IP')
  assert.equal(await acao('http://192.168.100.107:5173'), 'http://192.168.100.107:5173', 'served over the LAN')
  assert.equal(await acao('http://evil.example.com'), null, 'foreign origin gets no header')
  assert.equal(await acao('http://11.0.0.9:5173'), null, 'look-alike outside RFC 1918 stays blocked')
  config.corsAllowLocalOrigins = false
  try {
    assert.equal(await acao('http://localhost:6789'), null, 'production keeps the strict list')
    assert.equal(await acao('http://localhost:5173'), 'http://localhost:5173', 'the list itself still works')
  } finally {
    config.corsAllowLocalOrigins = true
  }
})

test('one process: the API also serves the built app on the same origin as /api', async () => {
  const page = await api('GET', '/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') || '', /text\/html/, 'index.html wins over the docs JSON')
  assert.match(page.text, /Nexora test shell/)
  const asset = await api('GET', '/assets/shell.js')
  assert.equal(asset.status, 200, 'build assets resolve relative to the page')
  const health = await api('GET', '/health')
  assert.equal(health.json.service, 'nexora-backend', 'the API still answers on that same origin')
  const ghost = await api('GET', '/definitely-not-a-file')
  assert.equal(ghost.status, 404, 'unknown paths stay API 404s, never a blank page')
  assert.equal(ghost.json.error.type, 'not_found')
})

test('schedule: auth guard, CRUD, ownership, reminders and dedup', async () => {
  assert.equal((await api('GET', '/api/schedule')).status, 401, 'listing needs a token')
  const { token } = await newUser()
  const other = (await newUser()).token

  assert.equal((await api('POST', '/api/schedule', { token, body: { title: 'x', dueAt: 'not-a-date' } })).status, 400, 'bad date rejected')
  const soonIso = new Date(Date.now() + 2 * 3600 * 1000).toISOString()
  const pastIso = new Date(Date.now() - 60 * 1000).toISOString()
  const farIso = new Date(Date.now() + 5 * 86400 * 1000).toISOString()
  const t1 = (await api('POST', '/api/schedule', { token, body: { title: 'Submit bill', notes: 'paperwork', dueAt: soonIso } })).json
  const t2 = (await api('POST', '/api/schedule', { token, body: { title: 'Call bank', dueAt: pastIso } })).json
  await api('POST', '/api/schedule', { token, body: { title: 'Trip', dueAt: farIso } })
  assert.ok(t1.id.startsWith('task_'), 'prefixed id')
  assert.equal((await api('GET', '/api/schedule', { token })).json.data.length, 3)

  const rem = await api('POST', '/api/schedule/reminders', { token, body: {} })
  assert.equal(rem.status, 200)
  assert.deepEqual(rem.json.upcoming, [t1.id], 'inside 24h = day-before nudge')
  assert.deepEqual(rem.json.due, [t2.id], 'past due = day-of nudge')
  assert.match(rem.json.content, /Submit bill/)
  assert.match(rem.json.content, /Call bank/)
  assert.equal(rem.json.creditsCharged, 0, 'mock mode is free')

  assert.equal((await api('POST', '/api/schedule/reminders/ack', { token, body: { ids: [t1.id, t2.id] } })).json.acked, 2)
  const rem2 = await api('POST', '/api/schedule/reminders', { token, body: {} })
  assert.equal(rem2.json.content, '', 'acked reminders never repeat')

  assert.equal((await api('PATCH', `/api/schedule/${t1.id}`, { token: other, body: { status: 'done' } })).status, 404, 'non-owner cannot touch a task')
  assert.equal((await api('DELETE', `/api/schedule/${t1.id}`, { token: other })).status, 404)
  const done = await api('PATCH', `/api/schedule/${t1.id}`, { token, body: { status: 'done' } })
  assert.equal(done.json.status, 'done')
  /* editing the date re-arms the nudge: the old stamp only covers the old due_at */
  const moved = await api('PATCH', `/api/schedule/${t1.id}`, { token, body: { dueAt: pastIso, status: 'open' } })
  assert.equal(moved.json.remindedAt, null, 'date change disarms the stamp')
  assert.equal((await api('DELETE', `/api/schedule/${t1.id}`, { token })).status, 204)
  assert.equal((await api('GET', '/api/schedule', { token })).json.data.length, 2)
})

/* ── Server-side TTS (/api/voice/synth) ────────────────────────────────
 * The test env forces OPENAI_API_KEY='', so `isTtsAvailable()` is false and every
 * request must answer with the honest 503 `tts_unavailable` shim — that is the
 * exact signal the frontend uses to fall through to browser TTS without any
 * user-visible error. These tests pin that contract plus the auth/validation
 * surface around it; the happy path (real OpenAI key) is out of scope here
 * because a test suite that paid per call is not a test suite. */
test('tts: requires auth', async () => {
  const r = await api('POST', '/api/voice/synth', { body: { text: 'hello' } })
  assert.equal(r.status, 401)
})

test('tts: 503 tts_unavailable in mock mode (empty key)', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/voice/synth', { token, body: { text: 'Bilkul, main kar dungi', language: 'hinglish', gender: 'female' } })
  assert.equal(r.status, 503)
  assert.equal(r.json.error.type, 'tts_unavailable')
  /* The client's fallback trigger reads `.message`, so it must be non-empty
     and phrased as a normal-sounding reason, not a stack trace. */
  assert.ok(r.json.error.message && r.json.error.message.length > 20)
})

test('tts: schema validation — empty text and oversize both 400', async () => {
  const { token } = await newUser()
  const empty = await api('POST', '/api/voice/synth', { token, body: { text: '   ' } })
  assert.equal(empty.status, 400, 'blank text is a schema failure, not a 503')
  const long = await api('POST', '/api/voice/synth', { token, body: { text: 'x'.repeat(2000) } })
  assert.equal(long.status, 400, 'text above the 1200 cap is refused BEFORE the provider check')
})

test('tts: unknown language enum 400', async () => {
  const { token } = await newUser()
  const r = await api('POST', '/api/voice/synth', { token, body: { text: 'hi', language: 'klingon' } })
  assert.equal(r.status, 400)
})

/* ── Hinglish naturalness pass (services/tts.js pure helpers) ───────────
 * The user's core complaint is "AI ki Hinglish voice original nahi lagti".
 * These don't hit the network — they pin the text + instructions shaping
 * that makes the difference between an American reading Hindi and a native
 * code-switcher. Keep them honest: check specific substrings, not exact
 * equality, so a future wording tweak to INDIC_CORE doesn't break the test
 * as long as the phoneme rules are still there. */
const tts = await import('../src/services/tts.js')

test('tts: prepareTextForSpeech rewrites the three Indic mispronunciations and is idempotent', () => {
  const raw = 'Bilkul, main kyun aaoon? Shayad kal milte hain.'
  const one = tts.prepareTextForSpeech(raw, { language: 'hinglish' })
  assert.match(one, /bil-kul/i, 'bilkul gets a syllable break')
  assert.match(one, /kayun/i, 'kyun becomes kayun')
  assert.match(one, /shaa-yad/i, 'shayad becomes shaa-yad')
  /* Re-running must not double-rewrite ("bil-kul"→"bil--kul") — critical
     because the client already normalizes then the server does again. */
  const two = tts.prepareTextForSpeech(one, { language: 'hinglish' })
  assert.equal(one, two, 'normalization is idempotent')
})

test('tts: prepareTextForSpeech keeps the sentence-initial capital on rewrites', () => {
  /* "Bilkul" as the first word must NOT lose its leading capital — the
     engine's prosody uses the capital as a sentence-start marker. Same for
     "Kyun" and "Shayad". */
  const out = tts.prepareTextForSpeech('Bilkul theek. Kyun nahi? Shayad haan.', { language: 'hinglish' })
  assert.match(out, /^Bil-kul/, 'Bilkul keeps its capital B')
  assert.match(out, /\bKayun\b/, 'Kyun keeps its capital K')
  assert.match(out, /\bShaa-yad\b/, 'Shayad keeps its capital S')
})

test('tts: prepareTextForSpeech does not touch plain English replies', () => {
  const raw = 'Kubernetes is running fine, but the API key is missing.'
  const out = tts.prepareTextForSpeech(raw, { language: 'en' })
  /* English path only strips URLs and normalizes punctuation — no word
     rewrites — so "but" / "is" / "API" stay intact. */
  assert.match(out, /but the API key is missing/, 'no Indic rewrite fires on en')
})

test('tts: prepareTextForSpeech expands symbols and demotes punctuation', () => {
  const raw = 'Save 50% — visit https://nexora.ai/pricing NOW!!!'
  const out = tts.prepareTextForSpeech(raw, { language: 'en' })
  assert.doesNotMatch(out, /https\:/, 'URL is replaced with a spoken placeholder')
  assert.match(out, /percent/, 'percent sign expands')
  assert.doesNotMatch(out, /!!!/, 'runs of exclaim collapse to one terminator')
  /* FULL-CAPS is spelled letter-by-letter by the engine unless we demote it. */
  assert.doesNotMatch(out, /\bNOW\b/, 'NOW → Now (acronym list only keeps real abbrevs)')
})

test('tts: buildTtsInstructions carries the phoneme rules for Hinglish', () => {
  const { text: spec } = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female' })
  assert.match(spec, /retroflex/i, 'engine told which t/d/n to use')
  assert.match(spec, /penult/, 'stress rule stated')
  assert.match(spec, /Indian-English/, 'accent baseline set')
  assert.match(spec, /NOT cartoon-cutesy/, 'female voice is grounded, not cutesy')
  const { text: male } = tts.buildTtsInstructions({ language: 'hinglish', gender: 'male' })
  assert.match(male, /adult male/i)
})

test('tts: pickTtsVoice honours gender and language hint', () => {
  assert.equal(tts.pickTtsVoice({ gender: 'male', language: 'hinglish' }), 'echo')
  assert.equal(tts.pickTtsVoice({ gender: 'female', language: 'hinglish' }), 'nova')
  /* Explicit allowed voice still wins. */
  assert.equal(tts.pickTtsVoice({ voice: 'shimmer', gender: 'male' }), 'shimmer')
  /* Unknown voice falls through to the gender pick, never returns garbage. */
  assert.equal(tts.pickTtsVoice({ voice: 'bogus', gender: 'female' }), 'nova')
})

test('tts: Hinglish phonetic rewrites cover the high-mispronunciation vocabulary', () => {
  /* A wider rewrite list on gpt-4o-mini-tts is what turns "kyun tha karti
     hoon" (mangled into a British reading) into something a Hindi/Urdu
     native can parse without effort. Every one of these words has been
     reported by users as "AI ko samajh nahi aata" — if a rewrite drops,
     the Hinglish voice quality drops with it. */
  const out = tts.prepareTextForSpeech('bilkul kyun tha karta hoon, shayad waqt nahi hai', { language: 'hinglish' })
  assert.match(out, /bil-kul/, 'bilkul keeps its syllable break')
  assert.match(out, /kayun/, 'kyun → kayun')
  assert.match(out, /thaa/, 'tha → thaa (retroflex held)')
  assert.match(out, /kar-taa/, 'karta → kar-taa (stem stress)')
  assert.match(out, /houn/, 'hoon → houn (not English "moon")')
  assert.match(out, /shaa-yad/, 'shayad → shaa-yad')
  assert.match(out, /vakht/, 'waqt → vakht')
  assert.match(out, /naa-hee/, 'nahi → naa-hee')
})

test('tts: pickTtsVoice maps Realtime names onto their closest TTS counterpart', () => {
  /* The user's Settings voice list offers marin/coral/sage/cedar/ash etc.
     (gpt-realtime built-ins) which have NO server-TTS equivalent by name.
     A user who picks "Marin" must hear the same warm female timbre in chat
     replies as they do in VoiceCall — otherwise the companion sounds like
     two different people across surfaces. If this test breaks, the whole
     voice-preference consistency contract is broken. */
  assert.equal(tts.pickTtsVoice({ voice: 'marin', gender: 'female' }), 'nova')
  assert.equal(tts.pickTtsVoice({ voice: 'coral', gender: 'female' }), 'shimmer')
  assert.equal(tts.pickTtsVoice({ voice: 'sage' }), 'alloy')
  assert.equal(tts.pickTtsVoice({ voice: 'cedar', gender: 'male' }), 'echo')
  assert.equal(tts.pickTtsVoice({ voice: 'ash', gender: 'male' }), 'fable')
})

test('tts: emotion detection enriches the style spec and nudges speed', () => {
  /* A laugh marker pulls a specific "laughing WITH them" line and a small
     positive speed delta so the reply doesn't sound like a weather report. */
  const laugh = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Hahaha, ye toh mazedaar tha!' })
  assert.match(laugh.text, /laughing WITH them/i, 'laugh marker fires the playful prosody line')
  assert.ok(laugh.speedDelta > 0, 'laugh nudges pace slightly faster')
  /* Sorry markers slow her down instead. */
  const sorry = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Sorry yaar, mujhe samajh nahi aaya' })
  assert.match(sorry.text, /soft and sincere/i, 'sorry marker fires the gentle prosody line')
  assert.ok(sorry.speedDelta < 0, 'sorry nudges pace slower')
  /* A question mark at the end pulls the rising-intonation prompt so she
     doesn't fall flat on the ask. */
  const ask = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Aap kaise hain?' })
  assert.match(ask.text, /rise naturally at the question mark/i, 'trailing question marks get a rising pitch instruction')
  /* Plain statement: no emotion line appended, speed unchanged. */
  const plain = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Main theek hoon.' })
  assert.equal(plain.speedDelta, 0)
  assert.doesNotMatch(plain.text, /laughing|soft and sincere|rise naturally/, 'calm replies keep the neutral spec')
})

test('tts: synth accepts a language and still 503s on mock key (no leak)', async () => {
  /* Contract pin: any user with a Hinglish setting that hits this server with
     a Groq key must get the SAME tts_unavailable shape as before, so the
     client keeps falling through to browser TTS. The route accepts `language`
     without complaint. */
  const { token } = await newUser()
  const r = await api('POST', '/api/voice/synth', { token, body: { text: 'Aap kaise hain', language: 'hinglish', gender: 'female' } })
  assert.equal(r.status, 503)
  assert.equal(r.json.error.type, 'tts_unavailable')
})


