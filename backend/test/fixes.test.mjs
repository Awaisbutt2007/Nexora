/* Regression tests for the 2026-11-09 deep-test bug report (docs/BUG_REPORT_2026-11-09.md).
   Same isolation contract as api.test.mjs: throwaway DB, mock AI (no network), strict auth. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_DB = path.join(os.tmpdir(), `nexora-fixes-${process.pid}-${Date.now()}.db`)
process.env.NODE_ENV = 'test'
process.env.DB_PATH = TEST_DB
process.env.OPENAI_API_KEY = ''
process.env.JWT_SECRET = 'nexora-test-secret'
process.env.CORS_ORIGIN = 'http://localhost:5173'
process.env.AUTH_RATE_LIMIT = '1000'
process.env.AUTH_IP_RATE_LIMIT = '1000'
process.env.AI_RATE_LIMIT_PER_MIN = '1000'
process.env.FREE_MONTHLY_CREDITS = '100'
process.env.AUTH_OPEN_MODE = '0'
process.env.DESKTOP_AGENT_SECRET = ''
process.env.LOCAL_UNLIMITED_TOKENS = '0'
process.env.HOSTED_CLIENT = '0'

let server
let BASE
let db

before(async () => {
  const { app } = await import('../src/index.js')
  const { getDb } = await import('../src/db/index.js')
  db = getDb()
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  BASE = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  try { db?.close() } catch { /* already closed */ }
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try { fs.rmSync(f, { force: true }) } catch { /* locked temp file */ }
  }
})

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* SSE or empty */ }
  return { status: res.status, json, text }
}

let n = 0
async function newUser() {
  n += 1
  const r = await api('POST', '/api/auth/register', { body: { name: 'Fix Tester', email: `fix${n}_${Date.now()}@example.com`, password: 'secret123' } })
  assert.equal(r.status, 201)
  return r.json
}

function lastCredits(sse) {
  const frames = sse.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)))
  return frames.reverse().find((f) => typeof f.creditsRemaining === 'number')?.creditsRemaining
}

// ── #2 credit pricing ────────────────────────────────────────────────────────
test('fix #2: a short reply costs 1 credit, not the ~3.6k-token system prompt', async () => {
  const { estimateCredits } = await import('../src/services/ai.js')
  assert.equal(estimateCredits({ prompt_tokens: 3631, completion_tokens: 30, total_tokens: 3661 }), 1)
  assert.equal(estimateCredits({ prompt_tokens: 3631, completion_tokens: 450, total_tokens: 4081 }), 3)
  assert.equal(estimateCredits(null), 1)
})

// ── #3 monthly refill ────────────────────────────────────────────────────────
test('fix #3: free credits refill at the start of a new month (and never lower a balance)', async () => {
  const { user, token } = await newUser()
  db.prepare("UPDATE users SET credits_remaining = 0, created_at = '2020-01-15T00:00:00.000Z', credits_refilled_at = NULL WHERE id = ?").run(user.id)
  const me = await api('GET', '/api/auth/me', { token })
  assert.equal(me.json.user.creditsRemaining, 100, 'empty wallet from an old month is topped up')
  const again = await api('GET', '/api/auth/me', { token })
  assert.equal(again.json.user.creditsRemaining, 100, 'second request in the same month does not double-grant')
  db.prepare("UPDATE users SET credits_remaining = 0 WHERE id = ?").run(user.id)
  const same = await api('GET', '/api/auth/me', { token })
  assert.equal(same.json.user.creditsRemaining, 0, 'no refill twice in one month')
})

// ── #8 memory phrasing ───────────────────────────────────────────────────────
test('fix #8: "…, yaad rakhna" (keyword last) saves the fact; a trailing question is not stored', async () => {
  const { token } = await newUser()
  await api('POST', '/api/chat/completions', { token, body: { message: 'Mera favourite color blue hai, yaad rakhna. Aur 2+2 kitna hota hai?', stream: false } })
  const mem = await api('GET', '/api/memory', { token })
  const values = mem.json.data.map((m) => m.value)
  assert.ok(values.includes('Mera favourite color blue hai'), `saved: ${JSON.stringify(values)}`)
  assert.ok(!values.some((v) => /2\+2/.test(v)), 'the follow-up question is not a memory')
})

test('fix #8: keyword-first still works, and "do you remember…?" is not a command', async () => {
  const { token } = await newUser()
  await api('POST', '/api/chat/completions', { token, body: { message: 'yaad rakho: mujhe chai pasand hai', stream: false } })
  await api('POST', '/api/chat/completions', { token, body: { message: 'Do you remember my birthday?', stream: false } })
  const values = (await api('GET', '/api/memory', { token })).json.data.map((m) => m.value)
  assert.ok(values.includes('mujhe chai pasand hai'))
  assert.equal(values.length, 1, `only the real request is saved: ${JSON.stringify(values)}`)
})

// ── #9 image prompt enrichment ───────────────────────────────────────────────
test('fix #9: image enrichment keeps the subject and style the user asked for', async () => {
  const { enrichImagePrompt } = await import('../src/services/images.js')
  const robot = enrichImagePrompt('a cute robot waving anime style')
  assert.doesNotMatch(robot, /code editor/, 'a robot is drawn, not a code editor')
  assert.match(robot, /anime/)
  assert.doesNotMatch(robot, /illustration of/, 'a named style is not overridden with "illustration"')
  const girl = enrichImagePrompt('a girl smiling')
  assert.doesNotMatch(girl, /no people|no faces/, 'people requested → people allowed')
  assert.match(enrichImagePrompt('coding'), /code editor/, 'abstract coding topic keeps the tech scene')
})

// ── #10 image price from chat ────────────────────────────────────────────────
test('fix #10: an image made from chat costs the Image Generator price', async () => {
  const { user, token } = await newUser()
  const r = await api('POST', '/api/chat/completions', { token, body: { message: 'ek cat ki image bana do', stream: true } })
  const left = lastCredits(r.text)
  assert.ok(typeof left === 'number' && left <= 80, `100 − (20 image + reply) should be ≤ 80, got ${left}`)
  db.prepare('UPDATE users SET credits_remaining = 5 WHERE id = ?').run(user.id)
  const poor = await api('POST', '/api/chat/completions', { token, body: { message: 'ek cat ki image bana do', stream: true } })
  assert.equal(poor.status, 402, 'not enough credits for a picture → honest 402, no free image')
})

test('fix #10: premium tool runs report 0 credits charged', async () => {
  const { user, token } = await newUser()
  db.prepare("UPDATE users SET plan = 'pro', is_premium = 1 WHERE id = ?").run(user.id)
  const r = await api('POST', '/api/tools/code_assistant/run', { token, body: { prompt: 'reverse a string in js' } })
  assert.equal(r.status, 201)
  assert.equal(r.json.creditsCharged, 0)
})

// ── #19 honest tool names ────────────────────────────────────────────────────
test('fix #19: paste-only tools are not advertised as PDF / YouTube readers', async () => {
  const { token } = await newUser()
  const names = (await api('GET', '/api/tools', { token })).json.data.map((t) => t.name)
  assert.ok(!names.includes('PDF Reader') && !names.includes('YouTube Notes'), JSON.stringify(names))
})

// ── #20 / #29 desktop ────────────────────────────────────────────────────────
test('fix #20/#29: absent desktop agent is a 503 and no AI call is made for /intent', async () => {
  const { token } = await newUser()
  const h = await api('GET', '/api/desktop/health', { token })
  assert.equal(h.status, 503)
  const i = await api('POST', '/api/desktop/intent', { token, body: { utterance: 'open notepad' } })
  assert.equal(i.status, 503)
})

// ── #14 plans ────────────────────────────────────────────────────────────────
test('fix #14: the free plan is priced at 0', async () => {
  const { token } = await newUser()
  const plans = (await api('GET', '/api/user/plans', { token })).json.data
  assert.equal(plans.find((p) => p.id === 'free').pricePkr, 0)
})
