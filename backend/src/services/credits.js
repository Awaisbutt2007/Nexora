import { getDb, nowIso } from '../db/index.js'
import { PLANS, config } from '../config.js'

const monthKey = (iso) => {
  const d = new Date(iso || 0)
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}-${d.getUTCMonth()}`
}

/* Free accounts get their monthly allowance back at the start of each calendar month
   (UTC). Tops UP to the allowance — never lowers a balance that is already higher.
   Takes and returns a raw users row so requireAuth can call it on every request
   cheaply: the UPDATE only runs on the first request of a new month. */
export function refillMonthlyCredits(row) {
  if (!row || row.is_premium || row.plan !== 'free') return row
  const now = nowIso()
  const last = row.credits_refilled_at || row.created_at
  if (monthKey(last) === monthKey(now)) return row
  const allowance = config.freeMonthlyCredits
  const credits = Math.max(row.credits_remaining || 0, allowance)
  getDb()
    .prepare('UPDATE users SET credits_remaining = ?, credits_refilled_at = ?, updated_at = ? WHERE id = ?')
    .run(credits, now, now, row.id)
  return { ...row, credits_remaining: credits, credits_refilled_at: now }
}

export function ensureCredits(user, cost = 1) {
  if (user.isPremium || user.plan === 'pro' || user.plan === 'yearly_pro') {
    return { ok: true, unlimited: true }
  }
  if (user.creditsRemaining < cost) {
    const err = new Error('Insufficient credits. Upgrade to Pro for unlimited access.')
    err.status = 402
    err.type = 'insufficient_credits'
    throw err
  }
  return { ok: true, unlimited: false }
}

export function deductCredits(userId, cost = 1) {
  const db = getDb()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) return null
  if (user.is_premium) return user

  const next = Math.max(0, user.credits_remaining - cost)
  db.prepare(
    `UPDATE users SET credits_remaining = ?, updated_at = ? WHERE id = ?`,
  ).run(next, nowIso(), userId)

  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
}

export function upgradePlan(userId, planId) {
  const plan = PLANS[planId]
  if (!plan) {
    const err = new Error('Unknown plan')
    err.status = 400
    throw err
  }

  const isPremium = planId === 'pro' || planId === 'yearly_pro'
  const credits = isPremium ? 999999 : plan.credits

  getDb()
    .prepare(
      `UPDATE users SET plan = ?, is_premium = ?, credits_remaining = ?, updated_at = ? WHERE id = ?`,
    )
    .run(planId, isPremium ? 1 : 0, credits, nowIso(), userId)

  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId)
}
