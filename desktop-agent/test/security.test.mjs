import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateRequest, secretArgKeys } from '../src/allowlist.js'
import { redact } from '../src/audit.js'
import { PermissionManager } from '../src/permissions.js'
import { resolveWithinAllowed, PathEscapeError, organize } from '../src/fsops.js'
import { runWithTimeout, stopAll } from '../src/runner.js'
import { createApp } from '../src/index.js'

/* ── pure unit tests (no sockets, no browser) ─────────────────────────────── */

test('allowlist: unknown action is rejected before anything runs', () => {
  const v = validateRequest('shell.exec', { cmd: 'del C:\\' })
  assert.equal(v.ok, false)
  assert.match(v.reason, /not in the allowlist/)
})

test('allowlist: invalid args are rejected with structured issues', () => {
  const v = validateRequest('browser.open', { url: 'not-a-url' })
  assert.equal(v.ok, false)
  assert.ok(Array.isArray(v.issues) && v.issues.length)
})

test('allowlist: file: scheme URLs are refused (http(s) only)', () => {
  const v = validateRequest('browser.open', { url: 'file:///C:/Windows/win.ini' })
  assert.equal(v.ok, false)
})

test('allowlist: valid action parses and applies defaults', () => {
  const v = validateRequest('browser.open', { url: 'https://example.com' })
  assert.equal(v.ok, true)
  assert.equal(v.args.waitFor, 'load')
})

test('allowlist: destructive actions carry alwaysConfirm', () => {
  for (const id of ['files.write', 'files.organize', 'browser.submit', 'system.restart', 'system.shutdown']) {
    const v = validateRequest(id, id === 'files.write' ? { path: 'a.txt', content: 'x' } : id === 'files.organize' ? { dir: '.' } : id === 'browser.submit' ? { selector: 'button' } : {})
    assert.equal(v.ok, true, `${id} should be valid`)
    assert.equal(v.def.alwaysConfirm, true, `${id} must always confirm`)
  }
})

/* ── screen observation + desktop control allowlist (no OS is touched here) ── */

test('screen.capture validates and applies safe defaults', () => {
  const v = validateRequest('screen.capture', {})
  assert.equal(v.ok, true)
  assert.equal(v.args.maxWidth, 1920)
  assert.equal(v.args.save, false, 'must NOT save to disk unless explicitly asked')
  assert.equal(v.args.monitor, 'primary')
})

test('screen.capture refuses an absurd maxWidth', () => {
  assert.equal(validateRequest('screen.capture', { maxWidth: 100000 }).ok, false)
})

test('desktop coordinates are validated as whole pixels in range', () => {
  assert.equal(validateRequest('desktop.click', { x: 100, y: 200 }).ok, true)
  assert.equal(validateRequest('desktop.click', { x: -10, y: 5 }).ok, false, 'negative rejected')
  assert.equal(validateRequest('desktop.click', { x: 12.5, y: 5 }).ok, false, 'fractional rejected')
  assert.equal(validateRequest('desktop.click', { x: 999999, y: 5 }).ok, false, 'out of range rejected')
})

test('desktop.click applies button + double defaults', () => {
  const v = validateRequest('desktop.click', { x: 10, y: 20 })
  assert.equal(v.args.button, 'left')
  assert.equal(v.args.double, false)
  assert.equal(validateRequest('desktop.click', { x: 10, y: 20, button: 'side4' }).ok, false, 'unknown button rejected')
})

test('desktop.key only accepts the fixed safe combinations', () => {
  assert.equal(validateRequest('desktop.key', { combo: 'ctrl+c' }).ok, true)
  assert.equal(validateRequest('desktop.key', { combo: 'win+r' }).ok, false, 'no Win-key surface')
  assert.equal(validateRequest('desktop.key', { combo: 'ctrl+alt+delete' }).ok, false, 'no secure-attention sequence')
})

test('desktop.type is always-confirm and its text is a secret (never logged)', () => {
  const v = validateRequest('desktop.type', { text: 'hello world' })
  assert.equal(v.ok, true)
  assert.equal(v.def.alwaysConfirm, true)
  assert.deepEqual(secretArgKeys(v.def), ['text'])
  assert.ok(!v.def.preview(v.args).includes('hello world'), 'preview must not echo the typed text')
})

test('desktop.type rejects control characters (Enter/Tab belong in desktop.key)', () => {
  assert.equal(validateRequest('desktop.type', { text: 'a\nb' }).ok, false)
  assert.equal(validateRequest('desktop.type', { text: 'a\tb' }).ok, false)
})

test('audit redact: secret-ish keys and bearer tokens never leak', () => {
  const out = redact(
    { action: 'browser.fill', value: 'hunter2', password: 'p', authorization: 'Bearer abc.def', nested: { content: 'private file body' } },
    ['value'],
  )
  assert.equal(out.value, '[redacted]')
  assert.equal(out.password, '[redacted]')
  assert.equal(out.nested.content, '[redacted]')
  assert.match(out.authorization, /\[redacted\]/)
  assert.ok(!JSON.stringify(out).includes('hunter2'))
})

test('permissions: default-deny — nothing is granted at construction', () => {
  const p = new PermissionManager(null)
  assert.equal(p.isScopeGranted('files'), false)
  assert.equal(p.check({ scope: 'files', alwaysConfirm: false }).allowed, false)
})

test('permissions: grant then still blocked for alwaysConfirm without approval', () => {
  const p = new PermissionManager(null)
  p.grantScope('files')
  assert.equal(p.check({ scope: 'files', alwaysConfirm: false }).allowed, true)
  const blocked = p.check({ scope: 'files', alwaysConfirm: true, approvedThisAction: false })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.needsConfirm, true)
  assert.equal(p.check({ scope: 'files', alwaysConfirm: true, approvedThisAction: true }).allowed, true)
})

test('fs containment: paths outside the sandbox are refused', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-sandbox-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-outside-'))
  assert.throws(() => resolveWithinAllowed(path.join(outside, 'secret.txt'), [sandbox]), PathEscapeError)
  // traversal that resolves above the sandbox is refused too
  assert.throws(() => resolveWithinAllowed(path.join(sandbox, '..', 'outside.txt'), [sandbox]), PathEscapeError)
  // a real in-sandbox path is allowed
  const inner = path.join(sandbox, 'ok.txt')
  fs.writeFileSync(inner, 'hi')
  assert.equal(path.basename(resolveWithinAllowed(inner, [sandbox])), 'ok.txt')
})

test('organize dry-run does not move anything', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-org-'))
  fs.writeFileSync(path.join(sandbox, 'a.txt'), '1')
  fs.writeFileSync(path.join(sandbox, 'b.png'), '2')
  const res = organize({ dir: sandbox, strategy: 'by-extension', apply: false }, [sandbox])
  assert.equal(res.dryRun, true)
  assert.equal(res.applied, 0)
  assert.ok(fs.existsSync(path.join(sandbox, 'a.txt')))
})

test('runner: a handler that respects the signal is cancelled on timeout', async () => {
  const res = await runWithTimeout({
    action: 'test.slow',
    timeoutMs: 40,
    handler: (signal) => new Promise((_resolve, reject) => {
      const t = setInterval(() => { if (signal.aborted) { clearInterval(t); reject(signal.reason) } }, 5)
    }),
  })
  assert.equal(res.status, 'cancelled')
})

test('runner: a fast handler completes and stopAll on idle cancels nothing', async () => {
  const res = await runWithTimeout({ action: 'test.fast', timeoutMs: 1000, handler: async () => ({ done: true }) })
  assert.equal(res.status, 'completed')
  assert.equal(res.result.done, true)
  assert.equal(stopAll().count, 0)
})

/* ── HTTP integration tests (loopback, ephemeral port, throwaway secret) ──── */

let server
let BASE
let secret
let sandbox
const H = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` })

before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-agent-it-'))
  secret = 'test-agent-secret-0123456789abcdef'
  fs.writeFileSync(path.join(sandbox, 'report.log'), 'ERROR in build step 42\nline two')
  const cfg = {
    host: '127.0.0.1', port: 0, nodeEnv: 'test', secret,
    actionTimeoutMs: 5000,
    allowedDirs: [sandbox],
    approvedAppIds: [],
    browser: 'headless chromium',
    browserProfileDir: path.join(sandbox, 'profile'),
    allowedHosts: [],
    auditDir: path.join(sandbox, 'audit'),
    dataDir: path.join(sandbox, 'data'),
    rootDir: sandbox,
  }
  const { app } = createApp({ config: cfg })
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  BASE = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise((r) => server.close(r)))

async function api(method, route, { body, auth = true } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: auth ? H() : { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

test('GET /health is reachable without a token', async () => {
  const r = await api('GET', '/health', { auth: false })
  assert.equal(r.status, 200)
  assert.equal(r.json.loopbackOnly, true)
})

test('mutating routes reject a missing / wrong token', async () => {
  assert.equal((await api('POST', '/actions/plan', { body: { action: 'system.info' }, auth: false })).status, 401)
  const res = await fetch(`${BASE}/actions/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-wrong-wrong' }, body: JSON.stringify({ action: 'system.info' }) })
  assert.equal(res.status, 401)
})

test('plan → execute of a low-risk read-only action completes', async () => {
  // system.info lives under the (default-deny) "system" scope, so grant it first.
  await api('POST', '/permissions/grant', { body: { scope: 'system' } })
  const p = await api('POST', '/actions/plan', { body: { action: 'system.info' } })
  assert.equal(p.status, 200)
  assert.equal(p.json.ok, true)
  const e = await api('POST', '/actions/execute', { body: { planId: p.json.planId } })
  assert.equal(e.status, 200)
  assert.equal(e.json.status, 'completed')
})

test('execute is blocked by default-deny scope', async () => {
  const p = await api('POST', '/actions/plan', { body: { action: 'files.list', args: { dir: sandbox } } })
  assert.equal(p.json.ok, true)
  assert.equal(p.json.needsScope, 'files')
  const e = await api('POST', '/actions/execute', { body: { planId: p.json.planId } })
  assert.equal(e.status, 403)
  assert.equal(e.json.status, 'permission_denied')
})

test('grant scope → files.list reads only the sandbox', async () => {
  await api('POST', '/permissions/grant', { body: { scope: 'files' } })
  const p = await api('POST', '/actions/plan', { body: { action: 'files.list', args: { dir: sandbox } } })
  const e = await api('POST', '/actions/execute', { body: { planId: p.json.planId } })
  assert.equal(e.json.status, 'completed')
  assert.ok(e.json.result.entries.some((x) => x.name === 'report.log'))
})

test('file read OUTSIDE the sandbox fails safely (containment)', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-out-'))
  fs.writeFileSync(path.join(outside, 'passwd'), 'top-secret')
  const p = await api('POST', '/actions/plan', { body: { action: 'files.read', args: { path: path.join(outside, 'passwd') } } })
  const e = await api('POST', '/actions/execute', { body: { planId: p.json.planId } })
  assert.equal(e.json.ok, false)
  assert.match(e.json.reason, /outside the approved directories/)
})

test('alwaysConfirm action needs explicit approval, then succeeds', async () => {
  const p = await api('POST', '/actions/plan', { body: { action: 'files.write', args: { path: path.join(sandbox, 'notes.txt'), content: 'created by aira' } } })
  assert.equal(p.json.needsConfirm, true)
  const denied = await api('POST', '/actions/execute', { body: { planId: p.json.planId, approvedThisAction: false } })
  assert.equal(denied.json.status, 'needs_confirmation')
  // re-plan (first plan consumed) and approve
  const p2 = await api('POST', '/actions/plan', { body: { action: 'files.write', args: { path: path.join(sandbox, 'notes.txt'), content: 'created by aira' } } })
  const ok = await api('POST', '/actions/execute', { body: { planId: p2.json.planId, approvedThisAction: true } })
  assert.equal(ok.json.status, 'completed')
  assert.ok(fs.existsSync(path.join(sandbox, 'notes.txt')))
})

test('a consumed plan cannot be replayed', async () => {
  await api('POST', '/permissions/grant', { body: { scope: 'system' } })
  const p = await api('POST', '/actions/plan', { body: { action: 'system.info' } })
  await api('POST', '/actions/execute', { body: { planId: p.json.planId } })
  const again = await api('POST', '/actions/execute', { body: { planId: p.json.planId } })
  assert.equal(again.json.status, 'unknown_plan')
})

test('voice context may never arm a power action', async () => {
  const p = await api('POST', '/actions/plan', { body: { action: 'system.restart', context: { fromVoice: true } } })
  assert.equal(p.json.ok, false)
  assert.equal(p.json.status, 'voice_blocked')
})

test('desktop.type is gated twice: needs its scope AND a fresh confirm', async () => {
  const p = await api('POST', '/actions/plan', { body: { action: 'desktop.type', args: { text: 'secret note' } } })
  assert.equal(p.json.ok, true)
  assert.equal(p.json.needsScope, 'desktop')
  assert.equal(p.json.needsConfirm, true)
  // scope not granted → execute is refused before anything reaches the OS
  const denied = await api('POST', '/actions/execute', { body: { planId: p.json.planId, approvedThisAction: true } })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.status, 'permission_denied')
})

test('audit endpoint returns redacted entries — no file bodies or secrets', async () => {
  const r = await api('GET', '/audit?limit=100')
  assert.equal(r.status, 200)
  const blob = JSON.stringify(r.json.data)
  assert.ok(!blob.includes('top-secret'), 'leaked a file body')
  assert.ok(!blob.includes('created by aira'), 'leaked file content')
  assert.ok(!blob.includes(secret), 'leaked the agent secret')
})
