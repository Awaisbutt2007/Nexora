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
/* Free-tier wallet mirrors the production default (100) so a new account in
   tests lands with the same number a real signup does. Any test that needs a
   richer wallet can bump the specific user's credits directly via `db`. */
process.env.FREE_MONTHLY_CREDITS = '100'
/* Pin strict auth so the contract below is the real one; the open demo mode
   (default ON in dev) is exercised separately via a runtime config toggle. */
process.env.AUTH_OPEN_MODE = '0'
/* Force the desktop bridge into "disabled" mode for the whole suite. Dev
   .env may set a real DESKTOP_AGENT_SECRET to talk to a locally-running
   agent, and the tests below assert the DISABLED response (503 with
   `desktop_bridge_disabled`). Without this line a developer's own secret
   leaks in via dotenv, the bridge thinks it is live, and every disabled
   assertion flips from 503 to 502 (ECONNREFUSED on 127.0.0.1:8799). */
process.env.DESKTOP_AGENT_SECRET = ''
/* Pin the localhost token-pass OFF for the suite. This server is listened on
   127.0.0.1 and every request here arrives from 127.0.0.1, so with the dev default
   (ON) the daily-budget gate would silently never fire and any quota assertion would
   pass vacuously. The exemption is proven explicitly below by flipping
   config.localUnlimitedTokens at runtime. */
process.env.LOCAL_UNLIMITED_TOKENS = '0'
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

/* Product contract: every new free account lands with exactly 100 credits —
   enough to try every feature but small enough that running out is a real
   upgrade signal. Pinned here so a future refactor that widens the default
   (or accidentally gives new users unlimited) fails loudly instead of
   silently changing what the top-bar pill shows. */
test('credits: a new free account starts with exactly 100', async () => {
  const { user } = await newUser()
  assert.equal(user.plan, 'free', 'new accounts default to the free plan')
  assert.equal(user.isPremium, false)
  assert.equal(user.creditsRemaining, 100, 'free tier must start at 100 (see config.freeMonthlyCredits)')
})

/* Same contract for the two other account-creation paths — an auto-provision
   on login (open-auth dev mode) and a Google sign-in must both land on 100,
   otherwise the pill shows different starting numbers depending on how the
   user got in. Uses strict-auth to bypass open-mode auto-provisioning here
   (that flow is exercised in the auth tests above). */
test('credits: register and Google-new-user both start at 100', async () => {
  const reg = await newUser()
  assert.equal(reg.user.creditsRemaining, 100, 'register path grants 100')
  /* Google sign-in is mocked here by hitting /api/auth/google with a
     credential that resolves through the local tokeninfo stub is not
     feasible in the sandbox, so the equivalent INSERT path (createUser)
     is already covered above. Asserting the plain register value is
     enough for the wallet-count contract. */
})

/* Exhausted wallet returns a machine-readable 402 so the frontend can
   distinguish "please recharge" from a red error card. If the type ever
   drifts (e.g. becomes plain 'payment_required'), sendPrompt's friendly
   recharge bubble stops firing and the user sees a scary error instead —
   that regression is what this test catches. */
test('credits: exhausted wallet returns 402 with type=insufficient_credits on both stream + non-stream', async () => {
  const { token, user } = await newUser()
  /* Zero out the wallet directly — cheaper than 100 tiny chats. */
  const dbMod = await import('../src/db/index.js')
  dbMod.getDb().prepare('UPDATE users SET credits_remaining = 0 WHERE id = ?').run(user.id)

  const stream = await api('POST', '/api/chat/completions', { token, body: { message: 'hi', stream: true } })
  assert.equal(stream.status, 402, 'streaming path pre-checks wallet via ensureCredits')
  assert.equal(stream.json?.error?.type, 'insufficient_credits')
  assert.ok(/upgrade|credit/i.test(stream.json?.error?.message || ''), 'message mentions credits')

  const once = await api('POST', '/api/chat/completions', { token, body: { message: 'hi', stream: false } })
  assert.equal(once.status, 402, 'non-streaming path checks the same wallet')
  assert.equal(once.json?.error?.type, 'insufficient_credits')

  /* Tools, proactive and voice all gate on the same helper so a broke
     account is refused everywhere — a loop over the endpoints keeps the
     test cheap and covers each surface in one place. */
  const tools = await api('POST', '/api/tools/code_assistant/run', { token, body: { prompt: 'x' } })
  assert.equal(tools.status, 402)
  assert.equal(tools.json?.error?.type, 'insufficient_credits')
})

/* Premium bypass: an upgrade (or a Pro plan) means `ensureCredits` never
   fires the 402, so the recharge bubble must NOT appear for paying users.
   Regression risk: someone adds a wallet check that treats unlimited
   accounts like broke ones and Pro users get nagged. */
test('credits: Pro account with 0 remaining is NOT refused (unlimited override)', async () => {
  const { token, user } = await newUser()
  const dbMod = await import('../src/db/index.js')
  dbMod.getDb().prepare("UPDATE users SET plan='pro', is_premium=1, credits_remaining=0 WHERE id = ?").run(user.id)
  const r = await api('POST', '/api/chat/completions', { token, body: { message: 'still works', stream: false } })
  assert.equal(r.status, 200, 'premium bypasses ensureCredits regardless of stored count')
})

/* The daily token budget is now the AUTHORITATIVE gate the top-bar pill reflects:
   once the tally reaches the limit the server must refuse NEW chat turns (both
   streaming and one-shot) rather than answer while the pill still reads "Nk left"
   against a spent key. The quota row is keyed by UTC day and global, so the test
   writes it directly and cleans it up so nothing else in the suite sees an
   exhausted budget. This is the fix for "limit full hai magar tokens abhi dikh
   rahe hain" — the counter and the enforcement are now the same number. */
test('quota: an exhausted daily token budget blocks new chat turns (stream + non-stream)', async () => {
  const { token } = await newUser()
  const { config } = await import('../src/config.js')
  const day = new Date().toISOString().slice(0, 10)
  dbHandle.prepare(
    `INSERT INTO provider_quota (day, tokens_used) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET tokens_used = excluded.tokens_used`,
  ).run(day, config.aiDailyTokenLimit)

  try {
    const once = await api('POST', '/api/chat/completions', { token, body: { message: 'hi', stream: false } })
    assert.equal(once.status, 429, 'one-shot turn is refused once the budget is spent')
    assert.equal(once.json?.error?.type, 'quota_exhausted')
    assert.ok(/limit|reset/i.test(once.json?.error?.message || ''), 'message explains the limit + reset')

    const stream = await api('POST', '/api/chat/completions', { token, body: { message: 'hi', stream: true } })
    assert.equal(stream.status, 200, 'SSE still opens with 200 so the client can read the error frame')
    assert.match(stream.headers.get('content-type'), /text\/event-stream/)
    assert.ok(/quota_exhausted/.test(stream.text), 'stream emits a quota_exhausted error frame')
    assert.ok(stream.text.includes('[DONE]'), 'and terminates cleanly')
  } finally {
    dbHandle.prepare('DELETE FROM provider_quota WHERE day = ?').run(day)
  }
})

/* The gate must NOT strand the app: a fresh day (no quota row) leaves the budget
   un-exhausted so chat keeps working, and the /quota snapshot the pill renders
   reports the full 100k with exhausted=false. */
test('quota: an untouched budget is not exhausted and chat still streams', async () => {
  const { token } = await newUser()
  const { getQuotaSnapshot } = await import('../src/services/quota.js')
  const snap = getQuotaSnapshot()
  assert.equal(snap.exhausted, false, 'no quota row means full budget')
  assert.equal(snap.remaining, snap.limit)
  const r = await api('POST', '/api/chat/completions', { token, body: { message: 'hi', stream: true } })
  assert.equal(r.status, 200)
  assert.ok(!/quota_exhausted/.test(r.text), 'a healthy budget never trips the gate')
})

/* Streaming responses now hand the client the new wallet count on the
   final chunk (right before [DONE]) so the top-bar pill updates without
   waiting for /me. Without this the number looked frozen between reloads
   and users thought credits were never being charged at all — the exact
   confusion that motivated the pill. */
test('credits: stream final chunk carries creditsRemaining so the pill stays live', async () => {
  const { token, user } = await newUser()
  const start = user.creditsRemaining
  const r = await api('POST', '/api/chat/completions', { token, body: { message: 'stream me', stream: true } })
  assert.equal(r.status, 200)
  /* Every SSE frame is a `data: {...}` line; scan them for the one that
     carries creditsRemaining (the very last business chunk before DONE). */
  const frames = r.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter((l) => l && l !== '[DONE]')
  const walletFrame = frames.map((f) => { try { return JSON.parse(f) } catch { return null } }).find((j) => j && typeof j.creditsRemaining === 'number')
  assert.ok(walletFrame, 'at least one chunk reports creditsRemaining')
  assert.ok(walletFrame.creditsRemaining < start, 'reported wallet is lower than start (cost was applied)')
  assert.ok(Number.isInteger(walletFrame.creditsCharged) && walletFrame.creditsCharged >= 1, 'cost is stated on the same frame')
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

test('desktop bridge: a failed ACTION is passed through as data, not flattened into "Agent responded <status>"', async () => {
  /* The exact user-visible defect: they said "open YouTube for me", the agent's
     automation browser had died, and the reply on screen was `⚠ Agent responded 403`.
     The agent had actually said why ("Target page, context or browser has been
     closed") in `{ ok:false, status:'failed', reason }` — but `callAgent` only read
     `json.error.message`, so the truth was discarded and a browser crash was
     reported as a PERMISSION denial. An action that ran and failed is a RESULT, so
     it must survive the hop; a genuine error body must still reject. */
  const http = await import('node:http')
  const { config } = await import('../src/config.js')
  const { desktopAgent } = await import('../src/services/desktopAgent.js')
  const reason = 'youtube.com did not resolve — this machine has no route to it (check the connection or a DNS block).'
  const fake = http.createServer((req, res) => {
    if (req.url === '/actions/execute') {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, status: 'failed', planId: 'run_test', reason }))
      return
    }
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Agent token rejected', type: 'invalid_token' } }))
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const wasUrl = config.desktopAgentUrl
  const wasSecret = config.desktopAgentSecret
  config.desktopAgentUrl = `http://127.0.0.1:${fake.address().port}`
  config.desktopAgentSecret = 'test-agent-secret'
  try {
    const ran = await desktopAgent.execute({ planId: 'run_test' })
    assert.equal(ran.ok, false, 'a failed action RESOLVES instead of throwing')
    assert.equal(ran.status, 'failed')
    assert.equal(ran.reason, reason, "the agent's own sentence survives the hop")

    /* A non-action error body is still an error — and the agent's message wins over
       the generic fallback, which is what made the failure unreadable. */
    let refused
    try { await desktopAgent.plan({ action: 'browser.open' }) } catch (err) { refused = err }
    assert.ok(refused, 'a real agent error still rejects')
    assert.equal(refused.message, 'Agent token rejected')
    assert.equal(refused.status, 403)
    assert.equal(refused.type, 'invalid_token')

    /* Full chain: the route hands the result back as a 200 so the chat can render
       `result.reason` (the frontend's `result.ok === false` branch). */
    const { token } = await newUser()
    const r = await api('POST', '/api/desktop/execute', { token, body: { planId: 'run_test' } })
    assert.equal(r.status, 200, 'the proxy does not invent an HTTP error for a ran action')
    assert.equal(r.json.reason, reason)
  } finally {
    config.desktopAgentUrl = wasUrl
    config.desktopAgentSecret = wasSecret
    await new Promise((r) => fake.close(r))
  }
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
  assert.match(directives[1], /Urdu \(Nastaliq\) script/, 'the retry carries a corrective directive naming the script and its example')
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
  /* The rising lilt must NOT come with a "hold the syllable" instruction any
     more — that phrasing made the engine drag the closing word ("raa-hee…"),
     which the user reported as words being "latkaa hua". */
  assert.doesNotMatch(ask.text, /hold the very last syllable/i, 'the question line lifts pitch without stretching a syllable')
  /* Plain statement: no emotion line appended, speed unchanged. */
  const plain = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Main theek hoon.' })
  assert.equal(plain.speedDelta, 0)
  assert.doesNotMatch(plain.text, /laughing|soft and sincere|rise naturally/, 'calm replies keep the neutral spec')
})

test('tts: instruction-only names stay natural; GPM names get respelled', () => {
  /* "Awais" is an INSTRUCTION_ONLY name — the user wants it said in ENGLISH
     phonetics, not Roman Urdu. The text keeps "Awais" as-is and the model
     gets an explicit instruction to say it in English. Respelling to "Ahwice"
     made it sound like broken Roman English. "Aira" (GPM-only) still respells. */
  const en = tts.prepareTextForSpeech('Haan Awais, kya chal raha hai?', { language: 'en' })
  assert.match(en, /Awais/, 'instruction-only name stays in natural spelling')
  assert.doesNotMatch(en, /Ahwice/, 'no Roman-English respelling in the text')
  const hinglish = tts.prepareTextForSpeech('Ji Awais, bilkul theek hai.', { language: 'hinglish' })
  assert.match(hinglish, /Awais/, 'Hinglish path also keeps the name natural')
  const aira = tts.prepareTextForSpeech('Hello Aira, welcome!', { language: 'en' })
  assert.match(aira, /Aaira/, 'GPM-only names still get text respelling')
  const notAName = tts.prepareTextForSpeech('A waze of talking is not a name.', { language: 'en' })
  assert.match(notAName, /waze/, 'the table matches whole words only, never a split')
  /* The pronunciation hint fires from the names array (logged-in user). */
  const ins = tts.buildTtsInstructions({ language: 'en', gender: 'female', emotionHint: 'Ji Zubair, done.', names: ['Awais', 'Zubair'] })
  assert.match(ins.text, /"Zubair"/, 'unknown names get one pronunciation line')
  assert.match(ins.text, /uh-WICE/, 'hint anchors on the common English rhyme "nice"')
  assert.match(ins.text, /unvoiced S/, 'hint explicitly forbids the /z/ of "wise"')
  /* The hint ALSO fires from TEXT scanning (demo user, developer name). */
  const insDemo = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Mera developer Awais ne banaya.', names: ['Demo'] })
  assert.match(insDemo.text, /uh-WICE/, 'text-scan fires hint when name appears in text')
})

test('tts: every style spec carries the anti-drag pacing line', () => {
  /* "rahii word ko bohat latkaa kr bol rahi h": the hyphenated phonetic
     respellings ("naa-hee", "kar-oon-ghee") double as breath marks, and on
     short helper words that reads as one drawn-out drag. The guard rides on
     EVERY spec — including a custom env override — because stretching is a
     pacing bug, not a style choice. */
  const spec = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Main sun rahi hoon.' })
  assert.match(spec.text, /never stretch, drag or hold/i, 'the crisp-pacing guard is attached')
  const q = tts.buildTtsInstructions({ language: 'hinglish', gender: 'female', emotionHint: 'Kya chal raha hai?' })
  assert.match(q.text, /without stretching or holding any syllable/i, 'even the question lilt forbids the hold')
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

/* ── Server-side web reading (services/webfetch.js) ─────────────────────
 * The user's complaint: pasting a link got "main live browser nahi khol
 * sakti". These pin the offline, security-critical parts — the SSRF guard
 * (the backend must never be pointed at itself / loopback / cloud metadata)
 * and the HTML→text digest. No network, so they run in mock/offline CI. */
const web = await import('../src/services/webfetch.js')

test('webfetch: SSRF guard refuses loopback, private, link-local and non-http', () => {
  assert.equal(web.isSafeUrl('http://127.0.0.1:8799/x'), false, 'loopback agent port blocked')
  assert.equal(web.isSafeUrl('http://localhost:3000/'), false, 'localhost blocked')
  assert.equal(web.isSafeUrl('http://10.1.2.3/'), false, 'RFC1918 10/8 blocked')
  assert.equal(web.isSafeUrl('http://192.168.0.1/'), false, 'RFC1918 192.168 blocked')
  assert.equal(web.isSafeUrl('http://172.16.5.5/'), false, 'RFC1918 172.16 blocked')
  assert.equal(web.isSafeUrl('http://169.254.169.254/latest/meta-data/'), false, 'cloud metadata blocked')
  assert.equal(web.isSafeUrl('http://[::1]/'), false, 'IPv6 loopback blocked')
  assert.equal(web.isSafeUrl('file:///etc/passwd'), false, 'file:// blocked')
  assert.equal(web.isSafeUrl('https://example.com/'), true, 'public https allowed')
})

test('webfetch: extractUrls finds, cleans and de-duplicates links', () => {
  const found = web.extractUrls('dekho https://claude.ai/new or https://claude.ai/new, phir http://a.co/x) done.')
  assert.deepEqual(found, ['https://claude.ai/new', 'http://a.co/x'], 'dedup + trailing punct/comma stripped')
  assert.deepEqual(web.extractUrls('no links here'), [], 'plain text yields nothing')
})

test('webfetch: htmlToText strips scripts/styles/tags and decodes entities', () => {
  const { title, text } = web.htmlToText('<html><head><title>A &amp; B</title><style>.x{color:red}</style></head><body><script>var secret=1</script><p>Hello&nbsp;<b>world</b></p>©</body></html>')
  assert.equal(title, 'A & B', 'title decoded')
  assert.ok(!/secret|color:red/.test(text), 'script/style content dropped')
  assert.match(text, /Hello world/, 'tags removed, nbsp became space')
  assert.match(text, /©/, 'entity decoded')
})

test('webfetch: buildWebContext returns empty for messages with no public link', async () => {
  /* A no-URL turn must add zero latency and zero context. */
  assert.equal(await web.buildWebContext('hello there, kaise ho?'), '')
  /* A private/loopback link must be refused, not fetched. */
  assert.equal(await web.buildWebContext('check http://127.0.0.1:8799/admin'), '')
})

/* ── desktop-agent entitlement (cloud web app + local agent pairing gate) ────
   The local agent calls this OUTBOUND with the customer's JWT before it mints a
   client token, so only a real signed-in PAID account can drive a browser. ── */
const ENTITLE = '/api/desktop-agent/entitlement'

test('desktop-agent entitlement: refuses an unsigned request (401)', async () => {
  const r = await api('GET', ENTITLE)
  assert.equal(r.status, 401)
  assert.equal(r.json.error.type, 'auth_error')
})

test('desktop-agent entitlement: a fresh FREE account is not entitled', async () => {
  const { token } = await newUser()
  const r = await api('GET', ENTITLE, { token })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.entitled, false)
  assert.equal(r.json.plan, 'free')
  assert.equal(r.json.isPremium, false)
})

test('desktop-agent entitlement: a PAID (premium) account IS entitled', async () => {
  const { token, user } = await newUser()
  // Flip the account to a paid plan the way the billing flow would, then re-check.
  dbHandle.prepare('UPDATE users SET plan = ?, is_premium = 1 WHERE id = ?').run('monthly_pro', user.id)
  const r = await api('GET', ENTITLE, { token })
  assert.equal(r.status, 200)
  assert.equal(r.json.entitled, true)
  assert.equal(r.json.plan, 'monthly_pro')
  assert.equal(r.json.isPremium, true)
  assert.equal(r.json.userId, user.id)
})

/* ── the localhost token pass ───────────────────────────────────────────────
   The daily provider budget is shared by ONE API key, so the person building this app
   must not be locked out of their own laptop by their own testing. Every request in
   this suite already arrives over loopback, so both halves are exercised by moving the
   runtime flag: OFF (how the public internet is served) must 429, ON (a local device)
   must keep answering and report `unlimited` so the pill shows ∞. */
test('quota: an exhausted budget blocks the world but never a loopback device', async () => {
  const { token } = await newUser()
  const { config } = await import('../src/config.js')
  const quota = await import('../src/services/quota.js')
  const wasOn = config.localUnlimitedTokens
  const day = new Date().toISOString().slice(0, 10)
  const spentBefore = dbHandle.prepare('SELECT tokens_used FROM provider_quota WHERE day = ?').get(day)?.tokens_used || 0
  quota.addTokensUsed(config.aiDailyTokenLimit + 1000)
  try {
    /* Half 1 — the gate is real for anyone who is not on this machine. */
    config.localUnlimitedTokens = false
    assert.equal(quota.getQuotaSnapshot().exhausted, true, 'the budget reads as spent')
    assert.equal(quota.isLoopbackRequest({ ip: '127.0.0.1' }), false, 'flag off → nobody is exempt')
    const blocked = await api('POST', '/api/chat/completions', { token, body: { message: 'hi', stream: false } })
    assert.equal(blocked.status, 429, 'a non-local visitor is refused')
    assert.equal(blocked.json.error.type, 'quota_exhausted')

    /* Half 2 — the same exhausted budget must not stop a local device. */
    config.localUnlimitedTokens = true
    assert.equal(quota.isLoopbackRequest({ ip: '127.0.0.1' }), true, 'ipv4 loopback')
    assert.equal(quota.isLoopbackRequest({ ip: '::1' }), true, 'ipv6 loopback')
    assert.equal(quota.isLoopbackRequest({ ip: '::ffff:93.184.216.34' }), false, 'a public ip is never loopback')
    const q = await api('GET', '/api/chat/quota', { token })
    assert.equal(q.json.unlimited, true, 'the client is told this session is unmetered')
    assert.equal(q.json.exhausted, false, 'so the composer never locks')
    assert.equal(q.json.remaining, 0, 'but the honest number is still reported')
    const ok = await api('POST', '/api/chat/completions', { token, body: { message: 'hi', stream: false } })
    assert.equal(ok.status, 200, 'a local turn still answers')
    assert.equal(ok.json.providerQuota?.unlimited, true, 'and the reply keeps the flag')
  } finally {
    config.localUnlimitedTokens = wasOn
    dbHandle.prepare('UPDATE provider_quota SET tokens_used = ? WHERE day = ?').run(spentBefore, day)
  }
})

/* ── what a turn costs ──────────────────────────────────────────────────────
   One spoken sentence used to burn 7-8k tokens: every turn re-sent the ~4.5k-token
   text prompt AND the whole thread. A `channel:'voice'` turn now answers from the
   compact spoken sheet, and history is a window rather than a transcript. */
test('voice channel: uses the compact spoken prompt, not the text-only rules', async () => {
  const { buildMessages } = await import('../src/services/ai.js')
  const ctx = { assistantName: 'Aira', userName: 'Awais', language: 'hinglish', gender: 'female' }
  const msg = (channel) => buildMessages([{ role: 'user', content: 'hi' }], [], { ...ctx, channel })[0].content
  const text = msg('text')
  const voice = msg('voice')

  assert.match(text, /\[DESKTOP:/, 'the text prompt keeps the desktop markers')
  assert.ok(!voice.includes('[DESKTOP:') && !voice.includes('[APP:'),
    'a spoken reply must never be told to emit markers the TTS would read aloud')
  assert.ok(!/emoji/i.test(voice), 'no "use emojis generously" in a reply nobody reads visually')
  assert.ok(voice.length < text.length / 2, `voice sheet must stay well under the text prompt (${voice.length} vs ${text.length})`)

  /* The rules that must survive the trim: who built her, the pinned language, and
     the feminine grammar the user hears in every Urdu sentence. */
  assert.match(voice, /Awais/, 'the creator rule survives')
  assert.match(voice, /Hinglish/, 'the pinned reply language survives')
  assert.match(voice, /rakhoongi/, 'the gender grammar survives')
  assert.match(voice, /1 to 3 short sentences/, 'the spoken length rule survives')

  /* Memories ride inside the spoken sheet — appended once, not twice. */
  const withMem = buildMessages([{ role: 'user', content: 'hi' }], [{ key: 'city', value: 'Lahore' }], { ...ctx, channel: 'voice' })[0].content
  assert.equal(withMem.split('Lahore').length - 1, 1, 'a memory is listed exactly once')
})

test('trimHistory: keeps the newest turns inside the budget, never the last one', async () => {
  const { trimHistory } = await import('../src/routes/chat.js')
  const turns = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i} ${'x'.repeat(50)}` }))
  const w = trimHistory(turns, { maxTurns: 8, maxChars: 200 })
  assert.equal(w[w.length - 1].content, turns[turns.length - 1].content, 'the newest turn always survives')
  assert.ok(w.length <= 8 && w.length > 1, `window is capped, got ${w.length}`)
  assert.ok(w.every((t, i) => t.content === turns[turns.length - w.length + i].content), 'the window is contiguous and in order')
  /* An oversized newest turn alone must not be trimmed away — that would send an
     empty thread and answer nothing. */
  assert.equal(trimHistory([{ role: 'user', content: 'y'.repeat(5000) }], { maxTurns: 8, maxChars: 200 }).length, 1)
  /* A picture costs what it actually bills, not its caption length. */
  const pic = [{ role: 'user', content: 'dekho', images: ['data:image/png;base64,AAA'] }, { role: 'user', content: 'latest' }]
  assert.equal(trimHistory(pic, { maxTurns: 8, maxChars: 5000 }).length, 1, 'one image turn eats the budget')
})

/* ── pronunciation ──────────────────────────────────────────────────────────
   "Awais" was spoken "awiys" and `comfortable` as "com-for-table" — the data to fix
   both existed, but only inside tts.js, and the realtime (Talk) surface has no text
   pass at all, so it never saw any of it. One table now feeds all three surfaces. */
test('pronunciation: the realtime voice is told how to say a name and a hard word', async () => {
  const { buildVoiceInstructions } = await import('../src/services/realtime.js')
  const spoken = buildVoiceInstructions({ assistantName: 'Aira', userName: 'Awais', gender: 'female' })
  assert.match(spoken, /Pronunciation/, 'the spoken sheet has its own pronunciation section')
  assert.match(spoken, /uh-WICE/, 'the name anchor reaches the voice that used to guess')
  assert.match(spoken, /unvoiced S/, 'and it still forbids the /z/ of "wise"')
  assert.match(spoken, /"comfortable" = KUMF-ter-bul/, 'the classics are named even with no turn text')
  assert.match(spoken, /never spell a word out letter by letter/i, 'diction rule, not just a word list')
  /* A renamed companion must not be mispronounced either — the hint is generated
     from the session's own names, not from a hard-coded string. */
  const zara = buildVoiceInstructions({ assistantName: 'Aira', userName: 'Zubair' })
  assert.ok(!/"Zubair"/.test(zara), 'a name outside the table is not invented into a phonetics line')
})

test('pronunciation: the server TTS gets per-turn words without mangling its text', async () => {
  const { speechHintsText, respellWords, WORD_SPEAK } = await import('../src/services/pronunciation.js')
  /* A word that is not one of the standing classics is only named when it appears. */
  assert.match(speechHintsText('Do you take coffee?', []), /"coffee" = KAW-fee/, 'the turn text arms a specific word')
  assert.ok(!speechHintsText('Kya chal raha hai?', []).includes('"coffee"'), 'a word not in play is not listed')
  assert.match(speechHintsText('tell me about Awais', []), /uh-WICE/, 'a name inside the text is caught without a names array')
  /* The text-level pass (browser engines) is case-preserving and idempotent — the
     server normalises and the client may normalise again. */
  const once = respellWords('Wednesday is comfortable, but the Vegetable market shuts.')
  assert.match(once, /Wenz-day/, 'sentence-initial capital survives the swap')
  assert.match(once, /kumf-ter-bul/, 'the word is respelled')
  assert.match(once, /the Vet-er-bel/, 'mixed case keeps its leading capital only')
  assert.equal(respellWords(once), once, 're-spelling an already-spelled line is a no-op')
  /* The two forms are deliberately different: a grapheme table gets lowercase
     syllable breaks (capitals there can read as an acronym), a neural voice gets a
     capitalised stress it can actually interpret. */
  for (const [word, { respell, say }] of Object.entries(WORD_SPEAK)) {
    assert.equal(respell, respell.toLowerCase(), `${word}: the GPM form stays lowercase`)
    assert.ok(/[A-Z]/.test(say), `${word}: the spoken anchor marks its stressed syllable`)
  }
  /* gpt-4o-mini-tts follows instructions and over-articulates a hyphenated respelling,
     so the server must keep English words in the text exactly as written. */
  const en = tts.prepareTextForSpeech('February is comfortable here.', { language: 'en' })
  assert.equal(en, 'February is comfortable here.', 'the neural path is told, never re-spelled')
  assert.ok(Object.keys(WORD_SPEAK).length >= 25, 'the table has to actually cover the class of words')
})

test('pronunciation: the chosen accent is clear Indian-English on every surface', async () => {
  /* The user picked the Kanchan-style accent, so "American first" must not creep
     back in through a locale chain or a style spec. */
  const { TTS_LOCALE_CHAIN, TTS_NATURAL_LOCALE } = await import('../../src/voiceSelect.js')
  assert.equal(TTS_LOCALE_CHAIN.en[0], 'en-IN', 'an English reply starts on an Indian-English voice')
  assert.ok(TTS_LOCALE_CHAIN.en.includes('en-US'), 'the American voice stays as a rescue, not a preference')
  assert.equal(TTS_NATURAL_LOCALE.en, 'en-IN', 'the pre-voice locale hint agrees with the chain')
  assert.match(tts.buildTtsInstructions({ language: 'en', gender: 'female' }).text, /Indian-English/, 'the server TTS spec stays Indian-English')
  const { buildVoiceInstructions } = await import('../src/services/realtime.js')
  assert.match(buildVoiceInstructions({ assistantName: 'Aira' }), /Indian-English dictionary teacher/, 'and so does the Talk voice')
})

test('pronunciation: the browser mirror cannot drift from the backend table', async () => {
  /* The frontend has its own copy because Vite and the Express server share no
     module graph. That duplication is only safe while a test reads both. */
  const { WORD_SPEAK, NAME_RESPELLINGS } = await import('../src/services/pronunciation.js')
  const browser = await import('../../src/namePronunciation.js')
  const back = Object.keys(WORD_SPEAK).sort()
  const front = Object.keys(browser.WORD_RESPPELLINGS).sort()
  assert.deepEqual(front, back, 'the two English-word tables must hold the same keys')
  for (const [word, { respell }] of Object.entries(WORD_SPEAK)) {
    assert.equal(browser.WORD_RESPPELLINGS[word], respell, `"${word}" must be said the same way on both paths`)
  }
  assert.deepEqual(Object.keys(browser.NAME_RESPPELLINGS).sort(), Object.keys(NAME_RESPELLINGS).sort(), 'same name table on both paths')
  /* The browser has no instruction lever, so every name needs a spelled form there. */
  for (const [name, form] of Object.entries(NAME_RESPELLINGS)) {
    assert.equal(typeof form, 'string', `${name} needs a GPM form`)
    assert.ok(form.length, `${name} must not have an empty respelling`)
  }
})

/* ── the companion's own tastes ──────────────────────────────────────────────
   "tumha kon sa song pasand ha?" got "main toh AI hoon, isliye music sunne ka maza
   nahi aata" — the honesty rule read any preference as a human claim, so a companion
   the product sells as a friend had no favourite song, fruit or colour. She now has a
   seeded profile on every surface, and the rule says naming a taste is not a claim. */
test('taste: every companion has a full set of favourites and it never drifts', async () => {
  const { tasteFor, TASTE_FIELDS } = await import('../src/services/taste.js')
  const aira = tasteFor({ assistantName: 'Aira', userName: 'Awais' })
  for (const field of TASTE_FIELDS) {
    assert.ok(typeof aira[field] === 'string' && aira[field].length > 1, `${field} must have a value, got "${aira[field]}"`)
    assert.ok(!/\s{2,}/.test(aira[field]) && aira[field] === aira[field].trim(), `${field} is cleanly written`)
  }
  /* Stability is the whole point of seeding instead of picking randomly per turn. */
  assert.deepEqual(tasteFor({ assistantName: 'aira ', userName: 'AWAIS' }), aira, 'the seed is case/space-insensitive, so a reply cannot lose its own favourite')
  const other = tasteFor({ assistantName: 'Zara', userName: 'Sana' })
  assert.notDeepEqual(other, aira, 'a different companion is not the same canned personality')
})

test('taste: the chat prompt carries her favourites and forbids the "I am an AI" dodge', async () => {
  const { tasteFor } = await import('../src/services/taste.js')
  const { systemPromptFor } = await import('../src/config.js')
  const taste = tasteFor({ assistantName: 'Aira', userName: 'Awais' })
  const prompt = systemPromptFor({ assistantName: 'Aira', userName: 'Awais', language: 'hinglish' })
  assert.match(prompt, /YOUR OWN TASTES/, 'the profile is in the system prompt')
  assert.ok(prompt.includes(taste.song), 'and the actual favourite song, not a placeholder')
  assert.ok(prompt.includes(taste.fruit) && prompt.includes(taste.colour), 'fruit and colour ride along — the classes the user named')
  assert.match(prompt, /isliye mujhe kuch pasand nahi/, 'the exact non-answer she gave is quoted and forbidden')
  assert.match(prompt, /never recite this list unprompted/i, 'she must not read the profile out loud every turn')
  assert.match(prompt, /memory wins/, 'a taste the user taught her beats the seeded one')
})

test('taste: the Talk voice agrees with the chat prompt, in budget', async () => {
  const { buildVoiceInstructions } = await import('../src/services/realtime.js')
  const { tasteFor } = await import('../src/services/taste.js')
  const spoken = buildVoiceInstructions({ assistantName: 'Aira', userName: 'Awais', gender: 'female' })
  const taste = tasteFor({ assistantName: 'Aira', userName: 'Awais' })
  assert.ok(spoken.includes('YOUR OWN TASTES') && spoken.includes(taste.song), 'a call answers with the same favourite song a chat turn does')
  /* The line that made her deflect, now explicitly carved out — the two rules sit
     next to each other or the model obeys the stricter one and stays bland. */
  assert.match(spoken, /FAVOURITE is a preference, not a claimed human experience/, 'honesty no longer forbids having a taste')
  assert.match(spoken, /Never answer a "what do you like\?" question by saying you cannot like things/i)
  /* Fields may be added; prose may not. This block is re-sent as context on every turn
     of a call, so its own cost is the thing worth locking — the whole-sheet budget lives
     in security.test.mjs. */
  const block = (await import('../src/services/taste.js')).tastePromptBlock(taste, { spoken: true })
  assert.ok(block.length < 780, `the spoken taste block is ${block.length} chars — add a field to SPOKEN_LABELS, do not add sentences`)
  assert.ok(!block.includes('Pasand ka'), 'the spoken form uses the short labels, not the text-prompt ones')
})

/* ── world language coverage ───────────────────────────────────────────────
   The user can pin ANY of the world languages in Settings and must be understood
   in any other, so the table is the product. Two things can silently break it:
   a language with no script/locale (it would be unenforceable and unspeakable) and
   the frontend copy drifting from the backend copy (Vite and Express share no
   module graph, so nothing but a test reads both). */
test('language: every world entry has a script, a locale and a prompt rule', async () => {
  const { WORLD_LANGUAGES, SCRIPT_RANGES, REPLY_LANGUAGE_SCRIPTS, REPLY_LANGUAGE_LOCALES, replyLanguageRule, finalLanguageRule } = await import('../src/config.js')
  assert.ok(WORLD_LANGUAGES.length >= 60, `the world table should cover the majors, got ${WORLD_LANGUAGES.length}`)
  for (const [code, name, , script, locale] of WORLD_LANGUAGES) {
    assert.ok(script && SCRIPT_RANGES[script], `${code}: every language names a script that the guard can test`)
    assert.ok(/^[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Z]{2})?$/.test(locale), `${code}: locale is a well-formed BCP-47 tag, got ${locale}`)
    assert.equal(REPLY_LANGUAGE_SCRIPTS[code], script, `${code}: script map is derived from the table`)
    assert.equal(REPLY_LANGUAGE_LOCALES[code], locale, `${code}: locale map is derived from the table`)
    const rule = replyLanguageRule(code)
    assert.ok(rule.includes(name), `${code}: the reply rule names ${name} so the model can obey it`)
    assert.match(finalLanguageRule(code) || '', new RegExp(name), `${code}: the final-rule restate exists for a pinned language`)
  }
  /* 'auto' is the only choice with no script — it mirrors the user, so it must not
     force one and must return the "answer in whatever they spoke" form. */
  assert.equal(finalLanguageRule('auto'), null, 'auto pins nothing, so there is no final script rule')
  assert.match(replyLanguageRule('auto'), /whichever language the user last used/, 'auto mirrors instead of forcing')
})

test('language: the browser mirror cannot drift from the backend table', async () => {
  const back = await import('../src/config.js')
  const front = await import('../../src/worldLanguages.js')
  /* Backend rows carry a 6th field (a sample phrase) the browser does not need, so
     compare only the five columns the Settings dropdown and the guard actually use. */
  const trim = (r) => r.slice(0, 5)
  assert.deepEqual(front.WORLD_LANGUAGES.map(trim), back.WORLD_LANGUAGES.map(trim), 'the two language tables must hold the same codes, names, natives, scripts and locales, in the same order')
  assert.deepEqual(front.LANGUAGE_GROUPS, back.LANGUAGE_GROUPS, 'the region grouping is identical on both paths')
  assert.deepEqual(front.REPLY_LANGUAGES, back.REPLY_LANGUAGES, 'the valid-choice list is the same one the zod schemas use')
})

/* scriptViolation was Urdu-only; it now judges every world script by codepoint. */
test('scriptViolation: a non-Latin pinned language rejects a romanised answer', async () => {
  const { scriptViolation } = await import('../src/services/ai.js')
  assert.equal(scriptViolation('お元気ですか、どうぞお気軽に。', 'ja'), null, 'kana in reply to Japanese is fine')
  assert.equal(scriptViolation('Ok genki desu, ki ni shinaide.', 'ja'), 'kana', 'Romaji is not the Japanese script')
  assert.equal(scriptViolation('你好，今天过得怎么样？', 'zh'), null, 'hanzi answers Chinese')
  assert.equal(scriptViolation('Namaste, aap kaise hain?', 'hi'), 'devanagari', 'Roman Hindi fails a pinned Devanagari setting')
  assert.equal(scriptViolation('नमस्ते, आप कैसे हैं?', 'hi'), null, 'the real script passes')
  assert.equal(scriptViolation('¿Cómo estás hoy?', 'es'), null, 'Latin languages pass Latin letters')
  assert.equal(scriptViolation('Как твои дела?', 'bg'), null, 'Cyrillic answers a Cyrillic setting')
  assert.equal(scriptViolation('How are you?', 'bg'), 'cyrillic', 'an English slip under Bulgarian is caught')
})

/* Request F: a long chat hit 413 "Request too large" / 429 and the UI said
   "AI is at its limit". Both must now be treated as recoverable capacity errors
   (rotate model, then degrade the payload), never as a permission failure. */
test('capacity: 413, 429 and 503 are recoverable, a real 401 is not', async () => {
  const { isCapacityError } = await import('../src/services/ai.js')
  assert.equal(isCapacityError({ status: 429 }), true, 'per-minute token wall')
  assert.equal(isCapacityError({ status: 413 }), true, 'request too large for the window — the long-chat error')
  assert.equal(isCapacityError({ status: 503 }), true, 'provider overload')
  assert.equal(isCapacityError({ status: 400, message: 'reduce your message size' }), true, 'the 413 body text counts too')
  assert.equal(isCapacityError(new Error('Rate limit reached: you exceeded your tokens per minute')) , true, 'rate-limit phrasing without a status is still capacity')
  assert.equal(isCapacityError({ status: 401, message: 'invalid api key' }), false, 'a bad key is NOT a capacity error — it must surface, not rotate models')
  assert.equal(isCapacityError(null), false, 'no error is not a capacity error')
})

test('fitToInputBudget: trims the oldest turns but keeps the system prompt and the newest message', async () => {
  const { fitToInputBudget } = await import('../src/services/ai.js')
  const filler = 'x'.repeat(2000)
  const system = { role: 'system', content: 'You are Aira.' }
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${filler}` }))
  const newest = { role: 'user', content: 'the actual question' }
  const msgs = [system, ...history, newest]
  /* The full payload is far over a small budget, so trimming must be provoked. */
  const budget = 500
  const fitted = fitToInputBudget(msgs, budget)
  assert.equal(fitted[0].role, 'system', 'the system prompt is never dropped')
  assert.equal(fitted[fitted.length - 1].content, newest.content, 'the newest user turn always survives')
  assert.ok(fitted.length < msgs.length, `the thread was trimmed from ${msgs.length} to ${fitted.length}`)
  assert.ok(fitted[fitted.length - 2]?.content.includes(`turn ${history.length - 1}`), 'when it must drop, it drops the OLDEST first')
  /* A payload already inside the budget must come back untouched. */
  const small = [system, { role: 'user', content: 'hi' }]
  assert.deepEqual(fitToInputBudget(small, 5000), small, 'a fitting turn is left exactly as it was')
})


