import { timingSafeEqual, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import express from 'express'
import { z } from 'zod'
import { config, assertRuntimeSecretConfigured } from './config.js'
import { PermissionManager } from './permissions.js'
import { Agent } from './actions.js'
import { initAudit, recentAudit, audit } from './audit.js'
import { listApprovedApps } from './apps.js'
import * as browser from './browser.js'
import { createPairing } from './pairing.js'

/* The HTTP status for an action result. Answering 403 to everything that came
 * back `ok:false` — the first version — told the caller that a crashed browser or
 * an expired plan was a PERMISSION denial, and the backend bridge then threw the
 * agent's own `reason` away in favour of "Agent responded 403". Only two of these
 * statuses are actually about permission. */
export function httpStatusFor(result) {
  if (result?.ok) return 200
  switch (result?.status) {
    case 'invalid': return 400
    case 'unknown_plan': return 404
    case 'expired': return 409
    case 'permission_denied':
    case 'needs_confirmation':
    case 'voice_blocked': return 403
    /* failed / cancelled: the tool behind the agent broke or was STOPped. Nothing
       was withheld, so it must not be reported as a refusal. */
    default: return 502
  }
}

export function createApp({ config: cfg = config, permissions } = {}) {
  const perms = permissions || new PermissionManager(cfg.dataDir)
  const agent = new Agent({ config: cfg, permissions: perms })

  fs.mkdirSync(cfg.dataDir, { recursive: true })
  initAudit(cfg.auditDir)

  const app = express()
  app.use(express.json({ limit: '1mb' }))

  /* ── cloud web app + local agent ──────────────────────────────────────────
     In this mode the browser drives THIS agent directly (it is on the same PC, so
     the loopback bind still holds) instead of going through a cloud backend that can
     never reach it. That needs a credential the browser can hold — a client token —
     handed out through a code + a paid-account check. The classic shared-secret path
     (backend proxy / self-host) is left exactly as it was and still works. */
  const pairing = createPairing(cfg)
  const agentId = randomUUID()
  const origins = new Set(cfg.allowedOrigins || [])

  /* A caller is origin-allowed when it sends NO Origin at all (server-to-server: the
     backend proxy, curl, the test suite) or when its Origin is explicitly listed.
     Any other browser Origin is refused, so some other site the user happens to visit
     can never drive this agent. */
  function originAllowed(origin) {
    if (!origin) return true
    return origins.has(String(origin).replace(/\/+$/, ''))
  }
  function extractBearer(header) {
    return header && header.startsWith('Bearer ') ? header.slice(7) : ''
  }

  // CORS for allowed browser origins + preflight; refuse any other browser origin.
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin) {
      if (!originAllowed(origin)) {
        return res.status(403).json({ error: { message: `Origin "${origin}" is not allowed by this agent`, type: 'origin_not_allowed' } })
      }
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Max-Age', '600')
      if (req.method === 'OPTIONS') return res.status(204).end()
    }
    next()
  })

  /* Ask the cloud backend (OUTBOUND — the agent reaches the internet, never the
     reverse) whether this JWT is a real, paying account. Only a genuine paid login
     earns a client token; a bad/expired JWT or a downgraded free account is refused. */
  async function checkEntitlement(jwt) {
    if (!cfg.backendUrl) return { ok: false, reason: 'This agent has no NEXORA_BACKEND_URL configured, so it cannot verify a paid account.' }
    try {
      const res = await fetch(`${cfg.backendUrl}/api/desktop-agent/entitlement`, { headers: { Authorization: `Bearer ${jwt}` } })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) return { ok: false, reason: 'Sign in to Nexora first — that session is invalid or expired.' }
      if (!res.ok) return { ok: false, reason: data?.error?.message || `The Nexora backend responded ${res.status}.` }
      return { ok: true, entitled: Boolean(data.entitled), plan: data.plan, userId: data.userId, email: data.email }
    } catch (err) {
      return { ok: false, reason: `Could not reach the Nexora backend to verify your account (${err.message}).` }
    }
  }

  /* Timing-safe bearer check. If no secret is configured the agent fails CLOSED —
     every mutating route 503s rather than running unauthenticated. */
  function tokenOk(header) {
    if (!cfg.secret) return false
    const given = header && header.startsWith('Bearer ') ? header.slice(7) : ''
    const a = Buffer.from(given)
    const b = Buffer.from(cfg.secret)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /* Accept EITHER the shared AGENT_SECRET (classic backend proxy / self-host) OR a
     valid client token minted through pairing. A client-token caller must also come
     from an allowed Origin; a no-Origin caller can only ever be the shared secret.
     Fail closed when nothing is configured, and 401 on any bad/missing credential. */
  function requireAgent(req, res, next) {
    const bearer = extractBearer(req.headers.authorization)
    if (tokenOk(req.headers.authorization)) return next()
    const rec = bearer ? pairing.verifyToken(bearer) : null
    if (rec) {
      if (!originAllowed(req.headers.origin)) {
        return res.status(403).json({ error: { message: 'Origin not allowed for a paired client token', type: 'origin_not_allowed' } })
      }
      req.pairedUser = rec
      return next()
    }
    if (!cfg.secret) {
      return res.status(503).json({ error: { message: 'Agent secret not configured; refusing to act.', type: 'misconfigured' } })
    }
    return res.status(401).json({ error: { message: 'Invalid or missing agent token', type: 'auth_error' } })
  }

  // Unauthenticated, but leaks nothing beyond "I am the agent, which mode".
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'nexora-desktop-agent',
      bind: `${cfg.host}:${cfg.port}`,
      loopbackOnly: true,
      authConfigured: Boolean(cfg.secret),
      browserInstalled: true, // lazily probed below
      time: new Date().toISOString(),
    })
  })

  /* ── pairing endpoints (origin-gated; never expose the code — it lives only in
     the agent's console, the out-of-band anchor that makes the flow secure). ── */
  app.get('/pair/status', (req, res) => {
    if (!originAllowed(req.headers.origin)) {
      return res.status(403).json({ error: { message: 'Origin not allowed', type: 'origin_not_allowed' } })
    }
    res.json({ object: 'pair_status', agentId, awaitingPair: true, entitlementRequired: true, pairedCount: pairing.tokenCount(), backendConfigured: Boolean(cfg.backendUrl), version: '1.0.0' })
  })

  const pairSchema = z.object({ code: z.string().trim().length(6), jwt: z.string().trim().min(1) })
  app.post('/pair', async (req, res) => {
    if (!originAllowed(req.headers.origin)) {
      return res.status(403).json({ error: { message: 'Origin not allowed', type: 'origin_not_allowed' } })
    }
    const parsed = pairSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: { message: 'A 6-digit code and a signed-in token are required', type: 'invalid_request_error' } })
    }
    if (!pairing.verifyCode(parsed.data.code)) {
      audit({ event: 'pair.denied', reason: 'bad_code' })
      return res.status(403).json({ error: { message: 'Wrong or expired pairing code', type: 'bad_code' } })
    }
    const ent = await checkEntitlement(parsed.data.jwt)
    if (!ent.ok || !ent.entitled) {
      audit({ event: 'pair.denied', reason: ent.reason || 'not_entitled' })
      return res.status(403).json({ error: { message: ent.reason || 'A paid Nexora account is required to control your PC.', type: 'not_entitled' } })
    }
    const { token, expiresAt } = pairing.issueToken({ userId: ent.userId, email: ent.email, plan: ent.plan })
    pairing.rotateCode() // a code is single-use once it succeeds
    audit({ event: 'pair.success', userId: ent.userId, plan: ent.plan })
    res.json({ ok: true, token, expiresAt, agentId, user: { userId: ent.userId, plan: ent.plan } })
  })

  app.post('/pair/revoke', requireAgent, (req, res) => {
    const bearer = extractBearer(req.headers.authorization)
    res.json({ ok: true, revoked: bearer ? pairing.revokeToken(bearer) : false })
  })

  app.get('/agent/info', requireAgent, (req, res) => {
    res.json({ object: 'agent_info', agentId, pairedUser: req.pairedUser ? { userId: req.pairedUser.userId, plan: req.pairedUser.plan, email: req.pairedUser.email } : null })
  })

  app.get('/apps', requireAgent, (_req, res) => res.json({ object: 'list', data: listApprovedApps() }))
  app.get('/permissions', requireAgent, (_req, res) => res.json(perms.snapshot()))

  app.post('/permissions/grant', requireAgent, (req, res) => {
    const body = z.object({
      scope: z.enum(['browser', 'files', 'apps', 'system', 'screen', 'desktop']).optional(),
      allowedDir: z.string().max(500).optional(),
      approvedAppId: z.string().max(40).optional(),
      allowedHost: z.string().max(120).optional(),
    }).parse(req.body || {})
    let snap = perms.snapshot()
    if (body.scope) snap = perms.grantScope(body.scope, true)
    if (body.allowedDir) snap = perms.addAllowedDir(body.allowedDir)
    if (body.approvedAppId) snap = perms.addApprovedApp(body.approvedAppId)
    if (body.allowedHost) snap = perms.addAllowedHost(body.allowedHost)
    res.json({ ok: true, permissions: snap })
  })

  app.post('/permissions/revoke', requireAgent, (req, res) => {
    const body = z.object({
      scope: z.enum(['browser', 'files', 'apps', 'system', 'screen', 'desktop']).optional(),
      allowedDir: z.string().max(500).optional(),
    }).parse(req.body || {})
    let snap = perms.snapshot()
    if (body.allowedDir) snap = perms.removeAllowedDir(body.allowedDir)
    else snap = perms.revoke(body.scope)
    res.json({ ok: true, permissions: snap })
  })

  const planSchema = z.object({
    action: z.string().trim().min(1).max(60),
    args: z.record(z.string(), z.unknown()).default({}),
    context: z.object({ fromVoice: z.boolean().default(false) }).default({}),
  })

  app.post('/actions/plan', requireAgent, (req, res) => {
    const body = planSchema.parse(req.body || {})
    res.json(agent.plan(body.action, body.args, body.context))
  })

  app.post('/actions/execute', requireAgent, (req, res, next) => {
    const body = z.object({
      planId: z.string().min(1).max(64),
      approvedThisAction: z.boolean().default(false),
    }).parse(req.body || {})
    agent.execute(body.planId, { approvedThisAction: body.approvedThisAction })
      .then((r) => res.status(httpStatusFor(r)).json(r))
      .catch(next)
  })

  app.post('/stop', requireAgent, async (_req, res, next) => {
    try {
      const r = await agent.stop()
      res.json({ ok: true, ...r })
    } catch (err) { next(err) }
  })

  app.get('/audit', requireAgent, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    res.json({ object: 'list', data: recentAudit(limit) })
  })

  app.get('/stats', requireAgent, (_req, res) => res.json(agent.stats()))

  // 404 + error shape identical to the backend, so the bridge can pass it through.
  app.use((_req, res) => res.status(404).json({ error: { message: 'Not found', type: 'not_found' } }))
  app.use((err, _req, res, _next) => {
    if (err?.name === 'ZodError') return res.status(400).json({ error: { message: 'Invalid request', type: 'invalid_request_error', details: err.issues } })
    const status = err.status || 500
    res.status(status).json({ error: { message: status < 500 ? err.message : 'Agent error', type: err.type || 'server_error' } })
  })

  return { app, agent, perms, pairing, agentId }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  assertRuntimeSecretConfigured()
  const { app, pairing, agentId } = createApp()
  app.listen(config.port, config.host, () => {
    console.log(`Nexora desktop agent listening on http://${config.host}:${config.port} (loopback only)`)
    console.log(`Approved apps: ${config.approvedAppIds.join(', ') || '(none)'}`)
    console.log(`Allowed dirs : ${config.allowedDirs.join(', ') || '(none — file access denied by default)'}`)
    // The pairing code lives ONLY here in the operator's console — never over HTTP.
    const { code, expiresInMs } = pairing.currentCode()
    console.log('\n  Pair your Nexora web app to this PC:')
    console.log(`  → Pairing code: ${code}  (valid ~${Math.round(expiresInMs / 1000)}s, then it changes)`)
    console.log(`  → Allowed browser origins: ${config.allowedOrigins.join(', ') || '(none set — browser control disabled; add AGENT_ALLOWED_ORIGINS to .env)'}`)
    console.log(`  → Paid-account check via backend: ${config.backendUrl || '(NEXORA_BACKEND_URL not set — pairing refused)'}`)
    console.log(`  → Agent id: ${agentId}\n`)
    // Keep a live, valid code on screen for whoever is standing at this machine.
    const timer = setInterval(() => {
      const fresh = pairing.currentCode()
      console.log(`[pair] current pairing code: ${fresh.code} (valid ~${Math.round(fresh.expiresInMs / 1000)}s)`)
    }, Math.min(config.pairCodeTtlMs || 60000, 60000))
    timer.unref?.()
  })
  const shutdown = async () => { await browser.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
