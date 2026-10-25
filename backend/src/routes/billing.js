import { Router } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { config, PLANS, isAdmin } from '../config.js'
import { getDb, nowIso } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { upgradePlan } from '../services/credits.js'
import { aiLimiter } from '../middleware/rateLimit.js'

/* Manual Easypaisa / JazzCash upgrade flow — the honest stand-in for a hosted
   checkout the owner cannot run yet (no merchant account). The app shows the
   owner's wallet number + the plan price; the user pays in their own banking app
   and submits the transaction id; the owner approves it and ONLY then does the
   plan change. Nothing here moves money and nothing here grants premium to the
   requester — that is the whole point of keeping /user/upgrade refused in
   production. */

const router = Router()
router.use(requireAuth)

const PAID_PLANS = ['pro', 'yearly_pro']

/* One camelCase shape for every request row that leaves this router — the client
   never sees the snake_case columns, and the user's raw row is never exposed. */
function shape(r) {
  return {
    id: r.id,
    userId: r.user_id,
    plan: r.plan,
    method: r.method,
    amount: r.amount,
    txnId: r.txn_id,
    status: r.status,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at || null,
    reviewedBy: r.reviewed_by || null,
    note: r.note || null,
  }
}

/* Only the wallets the owner actually published. A method with no number is
   never offered, so the payment panel can't show a dead "send to ''" option. */
function enabledMethods() {
  const list = []
  if (config.seller.easypaisa) list.push({ id: 'easypaisa', label: 'Easypaisa', number: config.seller.easypaisa, accountName: config.seller.accountName })
  if (config.seller.jazzcash) list.push({ id: 'jazzcash', label: 'JazzCash', number: config.seller.jazzcash, accountName: config.seller.accountName })
  return list
}

/* What the client needs to render the flow: whether it is enabled, the wallet
   numbers, the paid plans + prices, whether THIS caller is an approver, and the
   caller's own recent requests (so a submitted one shows as "pending"). */
router.get('/status', (req, res) => {
  const mine = getDb()
    .prepare('SELECT * FROM billing_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(req.user.id)
    .map(shape)
  res.json({
    isAdmin: isAdmin(req.user),
    manualEnabled: config.manualPaymentsEnabled,
    methods: enabledMethods(),
    plans: PAID_PLANS.map((key) => ({ key, name: PLANS[key].name, pricePkr: PLANS[key].pricePkr })),
    myRequests: mine,
  })
})

const requestSchema = z.object({
  plan: z.enum(PAID_PLANS),
  method: z.enum(['easypaisa', 'jazzcash']),
  /* Easypaisa / JazzCash transaction ids are short alphanumeric strings (often
     with dashes). Only letters, digits and dashes are accepted — the value is
     stored for the owner to read, never executed, and this keeps quotes/newlines
     out of anything later echoed back. */
  txnId: z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9-]+$/, 'Transaction id must be letters, numbers or dashes only.'),
})

router.post('/request', aiLimiter, (req, res, next) => {
  try {
    if (!config.manualPaymentsEnabled) {
      return res.status(503).json({
        error: {
          message: 'Payments are not enabled on this server yet — the site owner has not configured a payment account. Your current plan keeps working as usual.',
          type: 'payment_unavailable',
        },
      })
    }
    const body = requestSchema.parse(req.body)
    if (!enabledMethods().some((m) => m.id === body.method)) {
      return res.status(400).json({ error: { message: 'That payment method is not available here.', type: 'invalid_request_error' } })
    }
    const db = getDb()
    // Never let someone re-request a plan they already paid for and were approved.
    const approved = db
      .prepare("SELECT id FROM billing_requests WHERE user_id = ? AND plan = ? AND status = 'approved' LIMIT 1")
      .get(req.user.id, body.plan)
    if (approved) {
      return res.status(409).json({ error: { message: 'That plan is already paid for.', type: 'already_upgraded' } })
    }
    const id = `bill_${nanoid(16)}`
    db.prepare(
      `INSERT INTO billing_requests (id, user_id, plan, method, amount, txn_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, req.user.id, body.plan, body.method, PLANS[body.plan].pricePkr, body.txnId, nowIso())
    const row = db.prepare('SELECT * FROM billing_requests WHERE id = ?').get(id)
    res.status(201).json({ request: shape(row), message: 'Sent! The owner will verify your payment and enable your plan shortly.' })
  } catch (err) {
    next(err)
  }
})

/* Fail-closed admin guard: a caller not in ADMIN_USER_IDS gets 403 and sees no
   rows. Applied per-route so the public /status and /request stay open to any
   signed-in user. */
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: { message: 'Admin access required.', type: 'forbidden' } })
  }
  next()
}

router.get('/requests', requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null
  const db = getDb()
  const rows = status
    ? db.prepare(
        `SELECT b.*, u.email AS userEmail, u.name AS userName FROM billing_requests b
         JOIN users u ON u.id = b.user_id WHERE b.status = ? ORDER BY b.created_at DESC LIMIT 200`,
      ).all(status)
    : db.prepare(
        `SELECT b.*, u.email AS userEmail, u.name AS userName FROM billing_requests b
         JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC LIMIT 200`,
      ).all()
  res.json({ object: 'list', data: rows.map((r) => ({ ...shape(r), userEmail: r.userEmail, userName: r.userName })) })
})

const reviewSchema = z.object({
  id: z.string().trim().min(1).max(80),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
})

router.post('/review', requireAdmin, (req, res, next) => {
  try {
    const body = reviewSchema.parse(req.body)
    const db = getDb()
    const row = db.prepare('SELECT * FROM billing_requests WHERE id = ?').get(body.id)
    if (!row) return res.status(404).json({ error: { message: 'Request not found.', type: 'not_found' } })
    if (row.status !== 'pending') {
      return res.status(409).json({ error: { message: `That request was already ${row.status}.`, type: 'already_reviewed' } })
    }
    const stamp = nowIso()
    if (body.decision === 'approve') {
      /* Grant the plan to the REQUESTER — never the approver. upgradePlan is the
         same server-side write /user/upgrade would do, reached only through the
         admin gate. */
      upgradePlan(row.user_id, row.plan)
      db.prepare("UPDATE billing_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ?, note = ? WHERE id = ?")
        .run(stamp, req.user.id, body.note ?? null, row.id)
    } else {
      db.prepare("UPDATE billing_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, note = ? WHERE id = ?")
        .run(stamp, req.user.id, body.note ?? null, row.id)
    }
    const updated = db.prepare('SELECT * FROM billing_requests WHERE id = ?').get(row.id)
    res.json({ request: shape(updated) })
  } catch (err) {
    next(err)
  }
})

export default router
