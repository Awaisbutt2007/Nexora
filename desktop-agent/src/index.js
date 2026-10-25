import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import express from 'express'
import { z } from 'zod'
import { config, assertRuntimeSecretConfigured } from './config.js'
import { PermissionManager } from './permissions.js'
import { Agent } from './actions.js'
import { initAudit, recentAudit } from './audit.js'
import { listApprovedApps } from './apps.js'
import * as browser from './browser.js'

export function createApp({ config: cfg = config, permissions } = {}) {
  const perms = permissions || new PermissionManager(cfg.dataDir)
  const agent = new Agent({ config: cfg, permissions: perms })

  fs.mkdirSync(cfg.dataDir, { recursive: true })
  initAudit(cfg.auditDir)

  const app = express()
  app.use(express.json({ limit: '1mb' }))

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

  function requireAgent(req, res, next) {
    if (!cfg.secret) {
      return res.status(503).json({ error: { message: 'Agent secret not configured; refusing to act.', type: 'misconfigured' } })
    }
    if (!tokenOk(req.headers.authorization)) {
      return res.status(401).json({ error: { message: 'Invalid or missing agent token', type: 'auth_error' } })
    }
    next()
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
      .then((r) => res.status(r.ok ? 200 : 403).json(r))
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

  return { app, agent, perms }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  assertRuntimeSecretConfigured()
  const { app } = createApp()
  app.listen(config.port, config.host, () => {
    console.log(`Nexora desktop agent listening on http://${config.host}:${config.port} (loopback only)`)
    console.log(`Approved apps: ${config.approvedAppIds.join(', ') || '(none)'}`)
    console.log(`Allowed dirs : ${config.allowedDirs.join(', ') || '(none — file access denied by default)'}`)
  })
  const shutdown = async () => { await browser.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
