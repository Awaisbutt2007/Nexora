import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { aiLimiter } from '../middleware/rateLimit.js'
import { desktopAgent } from '../services/desktopAgent.js'
import { captureScreen, inspectScreen } from '../services/desktopScreen.js'
import { translateIntent } from '../services/desktopNl.js'

const router = Router()
router.use(requireAuth)

/* The browser talks ONLY to this route (with its JWT). It never sees the agent
   secret and never opens a socket to the agent directly. Every handler forwards
   to the loopback agent and lets the shared errorHandler map agent errors. */

// GET /api/desktop/health — reports bridge status without throwing when disabled.
router.get('/health', async (_req, res) => {
  try {
    const data = await desktopAgent.health()
    res.json({ enabled: true, agent: data })
  } catch (err) {
    res.status(err.status || 502).json({ enabled: false, error: { message: err.message, type: err.type || 'desktop_agent_unavailable' } })
  }
})

router.get('/permissions', async (_req, res, next) => {
  try { res.json(await desktopAgent.permissions()) } catch (err) { next(err) }
})

router.get('/apps', async (_req, res, next) => {
  try { res.json(await desktopAgent.apps()) } catch (err) { next(err) }
})

const grantSchema = z.object({
  scope: z.enum(['browser', 'files', 'apps', 'system', 'screen', 'desktop']).optional(),
  allowedDir: z.string().trim().max(500).optional(),
  approvedAppId: z.string().trim().max(40).optional(),
  allowedHost: z.string().trim().max(120).optional(),
})
router.post('/permissions/grant', async (req, res, next) => {
  try { res.json(await desktopAgent.grant(grantSchema.parse(req.body || {}))) } catch (err) { next(err) }
})

router.post('/permissions/revoke', async (req, res, next) => {
  try { res.json(await desktopAgent.revoke(grantSchema.partial().parse(req.body || {}))) } catch (err) { next(err) }
})

const planSchema = z.object({
  action: z.string().trim().min(1).max(60),
  args: z.record(z.string(), z.unknown()).default({}),
  context: z.object({ fromVoice: z.boolean().default(false) }).default({ fromVoice: false }),
})
router.post('/plan', async (req, res, next) => {
  try { res.json(await desktopAgent.plan(planSchema.parse(req.body || {}))) } catch (err) { next(err) }
})

router.post('/execute', async (req, res, next) => {
  try {
    const body = z.object({ planId: z.string().min(1).max(64), approvedThisAction: z.boolean().default(false) }).parse(req.body || {})
    res.json(await desktopAgent.execute(body))
  } catch (err) { next(err) }
})

router.post('/stop', async (_req, res, next) => {
  try { res.json(await desktopAgent.stop()) } catch (err) { next(err) }
})

router.get('/audit', async (req, res, next) => {
  try { res.json(await desktopAgent.audit(req.query.limit)) } catch (err) { next(err) }
})

/* NL / voice → structured intent → agent plan. The model only PROPOSES; the agent
   validates against the allowlist and enforces permissions. Nothing executes here. */
router.post('/intent', async (req, res, next) => {
  try {
    const body = z.object({
      utterance: z.string().trim().min(1).max(2000),
      fromVoice: z.boolean().default(false),
      assistantName: z.string().trim().max(40).optional(),
    }).parse(req.body || {})
    const intent = await translateIntent({
      utterance: body.utterance,
      fromVoice: body.fromVoice,
      assistantName: body.assistantName,
      userName: req.user.name,
    })
    if (!intent.ok) return res.json({ kind: 'clarify', clarify: intent.clarify })
    // Hand the candidate to the agent for authoritative validation + preview.
    const plan = await desktopAgent.plan({ action: intent.action, args: intent.args, context: { fromVoice: body.fromVoice } })
    res.json({ kind: 'plan', proposed: { action: intent.action, args: intent.args }, plan })
  } catch (err) { next(err) }
})

/* ── Screen observation ─────────────────────────────────────────────────────
   Both go through the agent's plan→execute gate, so nothing is captured unless
   the user has granted the "screen" scope. The capture is ephemeral: /inspect
   returns only Aira's text report and never the image; /capture returns the data
   URL solely so the user can preview their own screen, still unsaved. */
router.post('/screen/capture', aiLimiter, async (req, res, next) => {
  try {
    const body = z.object({ save: z.boolean().default(false) }).parse(req.body || {})
    const shot = await captureScreen(body)
    res.json({ ok: true, width: shot.width, height: shot.height, format: shot.format, bytes: shot.bytes, saved: shot.saved || null, dataUrl: shot.dataUrl })
  } catch (err) { next(err) }
})

router.post('/screen/inspect', aiLimiter, async (req, res, next) => {
  try {
    const body = z.object({
      question: z.string().trim().max(1000).optional(),
      save: z.boolean().default(false),
      assistantName: z.string().trim().max(40).optional(),
    }).parse(req.body || {})
    res.json({ ok: true, ...(await inspectScreen({ ...body, userName: req.user.name })) })
  } catch (err) { next(err) }
})

export default router
