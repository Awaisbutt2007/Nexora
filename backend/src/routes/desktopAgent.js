import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { aiLimiter } from '../middleware/rateLimit.js'

const router = Router()
router.use(requireAuth)

/* Entitlement verification for the "cloud web app + local agent" pairing flow.
   A customer runs the Nexora Agent on their own PC and the browser drives it
   DIRECTLY (a cloud backend can never reach a remote machine's loopback). Before
   the agent hands that browser a client token it calls THIS route OUTBOUND with
   the customer's JWT, to prove the session is a real, signed-in, PAID account.

   Only a boolean posture leaves here — never the full user row. `requireAuth`
   already 401s a bad/expired token, so a signed-out or downgraded caller cannot
   pair, and the agent mints nothing without `entitled: true`. */
router.get('/entitlement', aiLimiter, (req, res) => {
  const entitled = Boolean(req.user.isPremium) || req.user.plan !== 'free'
  res.json({
    ok: true,
    entitled,
    plan: req.user.plan,
    isPremium: Boolean(req.user.isPremium),
    userId: req.user.id,
    email: req.user.email,
  })
})

export default router
