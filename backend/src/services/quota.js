import { getDb } from '../db/index.js'
import { config } from '../config.js'

/* The daily token budget the top-bar countdown reflects — and the hard gate that
   stops the app once it is spent. The provider caps the key with a per-day token
   budget and does NOT return a daily-remaining header, so the server keeps its own
   tally: EVERY token spent (on the primary model or any failover sibling) is added
   to today's row. When the remaining balance hits zero the chat route refuses new
   turns and the composer locks, so the pill can never read "Nk left" against an
   already-exhausted key. Counting all models (not just the primary) is what keeps
   the number honest — failover traffic used to run for free and stall the countdown.

   Day rolls over on the UTC calendar date, which is close enough to the provider's
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
   it can never reveal the engine behind the companion. `unlimited` is the localhost
   pass (see config.localUnlimitedTokens): the numbers stay truthful but `exhausted`
   is forced off, so the gate never fires and the pill renders ∞ instead of a
   countdown that would end in a lock-out nobody on their own machine should see. */
export function getQuotaSnapshot(unlimited = false) {
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
    exhausted: unlimited ? false : remaining <= 0,
    unlimited: Boolean(unlimited),
    /* When the budget rolls over — the day boundary, shown as a friendly hint. */
    resetsAt: nextReset.toISOString(),
  }
}

/* IPv6 loopback, IPv4 loopback, and the IPv4-mapped form Node hands you on a dual-
   stack socket (`::ffff:127.0.0.1`). */
const LOOPBACK_RE = /^(::1|127\.|0:0:0:0:0:0:1$|::ffff:127\.)/i

/* True when THIS request reached us from the machine this server runs on.
   `req.ip` is the only trustworthy signal, and it is exactly that: with
   `trust proxy` off (dev/test) it is the socket address, which cannot be forged in
   TCP; with it on (production) it is the client IP the proxy forwarded. Combined
   with the production branch of config.localUnlimitedTokens this can never exempt a
   real internet visitor. */
export function isLoopbackRequest(req) {
  if (!config.localUnlimitedTokens) return false
  const ip = req?.ip || req?.socket?.remoteAddress || ''
  return LOOPBACK_RE.test(ip)
}
