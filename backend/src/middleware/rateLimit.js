import { config } from '../config.js'

/* Dependency-free sliding-window brute-force guard for the auth endpoints.
   Mirrors the voice limiter (services/realtime.js) so the app gains protection
   without a new package. Two independent buckets are enforced:

     - per email+IP  (authRateLimit)     → stops password spraying one account
     - per IP        (authIpRateLimit)   → stops one host stuffing many accounts

   State is in-memory and clears on restart — acceptable for a single instance.
   Multi-instance deployments should front this with a shared store (Redis). */

const buckets = new Map()

function takeSlot(id, limit, windowMs) {
  const now = Date.now()
  const hits = (buckets.get(id) || []).filter((t) => now - t < windowMs)
  const blocked = hits.length >= limit
  hits.push(now)
  buckets.set(id, hits)
  return !blocked
}

export function authLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const email = String(req.body?.email || '').toLowerCase() || 'no-email'
  const windowMs = config.authRateWindowMs

  const accountOk = takeSlot(`auth:acct:${email}|${ip}`, config.authRateLimit, windowMs)
  const ipOk = takeSlot(`auth:ip:${ip}`, config.authIpRateLimit, windowMs)

  if (!accountOk || !ipOk) {
    res.setHeader('Retry-After', Math.ceil(windowMs / 1000))
    return res.status(429).json({
      error: { message: 'Too many attempts — please wait a few minutes before trying again.', type: 'rate_limited' },
    })
  }
  next()
}

/* Per-user throttle for expensive AI endpoints (chat completions, proactive,
   tool runs). Credits cap total spend, but NOT request burst — this stops one
   client from hammering the paid provider in a tight loop. Must run AFTER
   requireAuth so req.user is available to key the bucket. */
export function aiLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const who = req.user?.id || ip
  const windowMs = config.aiRateWindowMs
  if (!takeSlot(`ai:${who}|${ip}`, config.aiRateLimit, windowMs)) {
    res.setHeader('Retry-After', Math.ceil(windowMs / 1000))
    return res.status(429).json({
      error: { message: 'You are sending requests too quickly — please slow down and try again in a moment.', type: 'rate_limited' },
    })
  }
  next()
}

/* Per-IP throttle for GET /api/images/generate. That endpoint is loaded by plain
   <img src> tags, so it cannot carry a Bearer token — without this anyone could use
   the server as a free, unlimited image proxy. Generous enough for a chat that
   shows a few pictures; the browser caches each finished image for a day. */
const IMAGE_LIMIT = Math.max(1, Number(process.env.IMAGE_RATE_LIMIT || 15))
const IMAGE_WINDOW_MS = 5 * 60 * 1000
export function imageLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  if (!takeSlot(`img:${ip}`, IMAGE_LIMIT, IMAGE_WINDOW_MS)) {
    res.setHeader('Retry-After', Math.ceil(IMAGE_WINDOW_MS / 1000))
    return res.status(429).json({
      error: { message: 'Too many images in a short time — please wait a few minutes.', type: 'rate_limited' },
    })
  }
  next()
}

/* Light janitor: drop buckets whose newest hit already aged out of the window,
   so long-lived processes don't accumulate keys forever. */
setInterval(() => {
  const cutoff = Date.now() - config.authRateWindowMs
  for (const [id, hits] of buckets) {
    const live = hits.filter((t) => t > cutoff)
    if (live.length === 0) buckets.delete(id)
    else buckets.set(id, live)
  }
}, 15 * 60 * 1000).unref()
