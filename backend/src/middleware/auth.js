import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { getDb } from '../db/index.js'

/* True when a token predates the account's session floor (set on password change).
   `iat` is seconds; the floor is an ISO string. A token minted in the SAME second as
   the rotation is kept (>= floor), so the freshly-issued session survives while every
   earlier one — including a stolen 7-day token — is rejected. Fail-open on a missing
   floor or malformed date so an upgrade never locks anyone out. */
function isTokenRevoked(user, payload) {
  if (!user.tokens_valid_after || typeof payload.iat !== 'number') return false
  const floor = Math.floor(new Date(user.tokens_valid_after).getTime() / 1000)
  if (!Number.isFinite(floor)) return false
  return payload.iat < floor
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, plan: user.plan },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  )
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: { message: 'Authentication required', type: 'auth_error' } })
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret)
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(payload.sub)
    if (!user) {
      return res.status(401).json({ error: { message: 'User not found', type: 'auth_error' } })
    }
    if (isTokenRevoked(user, payload)) {
      return res.status(401).json({ error: { message: 'Session expired — please sign in again.', type: 'auth_error' } })
    }
    req.user = sanitizeUser(user)
    next()
  } catch {
    return res.status(401).json({ error: { message: 'Invalid or expired token', type: 'auth_error' } })
  }
}

export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return next()

  try {
    const payload = jwt.verify(token, config.jwtSecret)
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(payload.sub)
    if (user && !isTokenRevoked(user, payload)) req.user = sanitizeUser(user)
  } catch {
    // ignore invalid optional token
  }
  next()
}

/* Companion preferences ride in one JSON column. Parsing is defensive because a
   hand-edited or half-written row must never take a login down with it. */
function parsePrefs(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function sanitizeUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone || null,
    avatar: row.avatar || null,
    plan: row.plan,
    creditsRemaining: row.credits_remaining,
    isPremium: Boolean(row.is_premium),
    prefs: parsePrefs(row.prefs_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
