import { getDb } from '../db/index.js'
import { config } from '../config.js'

/* Groq's free tier caps the PRIMARY model with a daily token budget, and the
   "at its limit" wall appears exactly when that budget runs out. The provider
   does not return a daily-remaining header, so the server keeps its own tally:
   every token spent on the primary model is added to today's row and the
   remaining balance drives the live top-bar countdown.

   Day rolls over on the UTC calendar date, which is close enough to Groq's
   reset to make the countdown honest without extra bookkeeping. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/* Add the tokens a completed call consumed. Non-positive/NaN values are ignored
   so a mock-mode or usage-less response never corrupts the tally. */
export function addTokensUsed(n) {
  const tokens = Math.floor(Number(n) || 0)
  if (tokens <= 0) return getQuotaSnapshot()
  const db = getDb()
  const day = today()
  db.prepare(
    `INSERT INTO provider_quota (day, tokens_used) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used`,
  ).run(day, tokens)
  return getQuotaSnapshot()
}

/* The snapshot the client renders: no model name, no vendor, just numbers, so
   it can never reveal the engine behind the companion. */
export function getQuotaSnapshot() {
  const limit = config.aiDailyTokenLimit
  const day = today()
  const row = getDb().prepare('SELECT tokens_used FROM provider_quota WHERE day = ?').get(day)
  const used = row?.tokens_used || 0
  const remaining = Math.max(0, limit - used)
  const nextReset = new Date()
  nextReset.setUTCDate(nextReset.getUTCDate() + 1)
  nextReset.setUTCHours(0, 0, 0, 0)
  return {
    limit,
    used,
    remaining,
    exhausted: remaining <= 0,
    /* When the budget rolls over — the day boundary, shown as a friendly hint. */
    resetsAt: nextReset.toISOString(),
  }
}
