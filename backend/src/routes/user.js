import { Router } from 'express'
import { z } from 'zod'
import { config, PLANS, REPLY_LANGUAGES } from '../config.js'
import { getDb, nowIso } from '../db/index.js'
import { requireAuth, sanitizeUser } from '../middleware/auth.js'
import { upgradePlan } from '../services/credits.js'

const router = Router()
router.use(requireAuth)

router.get('/profile', (req, res) => {
  res.json({ user: req.user, plans: Object.values(PLANS) })
})

/* The companion choices the workspace sends up whenever one of them changes. Keys
   are merged, so a client that only knows the language never blanks the persona. */
const prefsSchema = z
  .object({
    voice: z.string().trim().max(20).optional(),
    language: z.enum(REPLY_LANGUAGES).optional(),
    assistantName: z.string().trim().min(1).max(40).optional(),
    persona: z.string().trim().max(400).optional(),
    gender: z.enum(['female', 'male']).optional(),
  })
  .strict()

router.patch('/profile', (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      phone: z.string().trim().max(32).optional().nullable(),
      prefs: prefsSchema.optional(),
    })
    const body = schema.parse(req.body)
    const db = getDb()
    const stamp = nowIso()

    if (body.name) {
      db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').run(body.name, stamp, req.user.id)
    }
    if (body.phone !== undefined) {
      db.prepare('UPDATE users SET phone = ?, updated_at = ? WHERE id = ?').run(body.phone, stamp, req.user.id)
    }
    if (body.prefs) {
      const prefs = { ...req.user.prefs, ...body.prefs }
      db.prepare('UPDATE users SET prefs_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(prefs), stamp, req.user.id)
    }

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    res.json({ user: sanitizeUser(row) })
  } catch (err) {
    next(err)
  }
})

router.get('/plans', (_req, res) => {
  res.json({ object: 'list', data: Object.values(PLANS) })
})

router.post('/upgrade', (req, res, next) => {
  try {
    const schema = z.object({
      plan: z.enum(['free', 'pro', 'yearly_pro']),
    })
    const body = schema.parse(req.body)
    /* On a public deployment with no wired payment provider, a self-service upgrade
       would mint unlimited premium credits for free. Refuse UPGRADES (a downgrade to
       'free' is always fine) until billing is configured; dev/test keep the demo. */
    if (config.nodeEnv === 'production' && !config.paymentsEnabled && body.plan !== 'free') {
      return res.status(503).json({
        error: {
          message: "Plan changes aren't available on this server yet — billing isn't configured. Your current plan keeps working as usual; contact the site owner to enable upgrades.",
          type: 'payment_unavailable',
        },
      })
    }
    const row = upgradePlan(req.user.id, body.plan)
    res.json({
      user: sanitizeUser(row),
      message:
        body.plan === 'free'
          ? 'Downgraded to Starter.'
          : `Upgraded to ${PLANS[body.plan].name}. Unlimited credits unlocked.`,
    })
  } catch (err) {
    next(err)
  }
})

export default router
