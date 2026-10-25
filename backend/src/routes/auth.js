import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { config } from '../config.js'
import { getDb, nowIso } from '../db/index.js'
import { requireAuth, sanitizeUser, signToken } from '../middleware/auth.js'
import { authLimiter } from '../middleware/rateLimit.js'

const router = Router()

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160),
  password: z.string().min(6).max(128),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
})

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
})

/* Open demo mode (config.openAuth, ON unless AUTH_OPEN_MODE=0): any
   email/password gets in — the strict schemas above stay the production
   contract and the tests keep exercising them via a runtime toggle. */
const registerSchemaOpen = z.object({
  name: z.string().trim().max(80).optional().default(''),
  email: z.string().trim().min(2).max(160),
  password: z.string().max(128).optional().default(''),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
})

const loginSchemaOpen = z.object({
  email: z.string().trim().min(2).max(160),
  password: z.string().max(128).optional().default(''),
})

/* Shared account creation for register + login auto-provisioning. A blank
   password gets an unusable random one, exactly like the Google flow. */
async function createUser(db, { email, name, phone, password }) {
  const id = `usr_${nanoid(16)}`
  const stamp = nowIso()
  const passwordHash = await bcrypt.hash(password || nanoid(24), 10)
  db.prepare(
    `INSERT INTO users (id, email, name, phone, password_hash, plan, credits_remaining, is_premium, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'free', ?, 0, ?, ?)`,
  ).run(id, email, name, phone || null, passwordHash, config.freeMonthlyCredits, stamp, stamp)
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

const googleSchema = z.object({
  credential: z.string().min(10),
})

// Verify a Google ID token via Google's tokeninfo endpoint (no extra deps needed).
async function verifyGoogleToken(credential) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`)
  if (!res.ok) throw Object.assign(new Error('Invalid Google credential'), { status: 401 })
  const payload = await res.json()
  if (config.googleClientId && payload.aud !== config.googleClientId) {
    throw Object.assign(new Error('Google token audience mismatch'), { status: 401 })
  }
  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw Object.assign(new Error('Google email is not verified'), { status: 401 })
  }
  return payload
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const open = config.openAuth
    const body = (open ? registerSchemaOpen : registerSchema).parse(req.body)
    const db = getDb()
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email.toLowerCase())
    if (existing) {
      return res.status(409).json({ error: { message: 'Email already registered', type: 'conflict' } })
    }

    const name = body.name || body.email.split('@')[0].slice(0, 80) || 'Friend'
    const row = await createUser(db, { email: body.email.toLowerCase(), name, phone: body.phone, password: body.password })

    const user = sanitizeUser(row)
    const token = signToken(user)
    res.status(201).json({ user, token })
  } catch (err) {
    next(err)
  }
})

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const open = config.openAuth
    const body = (open ? loginSchemaOpen : loginSchema).parse(req.body)
    const db = getDb()
    let row = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email.toLowerCase())
    if (!row) {
      /* Open mode: an unknown email IS the signup — provision and continue. */
      if (!open) {
        return res.status(401).json({ error: { message: 'Invalid email or password', type: 'auth_error' } })
      }
      row = await createUser(db, {
        email: body.email.toLowerCase(),
        name: body.email.split('@')[0].slice(0, 80) || 'Friend',
        password: body.password,
      })
    } else if (!open) {
      const ok = await bcrypt.compare(body.password, row.password_hash)
      if (!ok) {
        return res.status(401).json({ error: { message: 'Invalid email or password', type: 'auth_error' } })
      }
    }

    const user = sanitizeUser(row)
    res.json({ user, token: signToken(user) })
  } catch (err) {
    next(err)
  }
})

router.post('/google', authLimiter, async (req, res, next) => {
  try {
    const { credential } = googleSchema.parse(req.body)
    const googleUser = await verifyGoogleToken(credential)
    const db = getDb()
    const email = String(googleUser.email || '').toLowerCase()
    if (!email) {
      return res.status(400).json({ error: { message: 'Google account has no email', type: 'auth_error' } })
    }

    let row = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    const stamp = nowIso()

    if (row) {
      // Refresh avatar/name and link the Google subject on returning users
      db.prepare('UPDATE users SET avatar = ?, name = ?, google_sub = ?, updated_at = ? WHERE id = ?')
        .run(googleUser.picture || row.avatar, row.name || googleUser.name || email, googleUser.sub, stamp, row.id)
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id)
    } else {
      const id = `usr_${nanoid(16)}`
      // Google-only accounts get an unusable random password
      const passwordHash = await bcrypt.hash(nanoid(24), 10)
      db.prepare(
        `INSERT INTO users (id, email, name, phone, password_hash, avatar, google_sub, plan, credits_remaining, is_premium, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'free', ?, 0, ?, ?)`,
      ).run(
        id,
        email,
        googleUser.name || email.split('@')[0],
        passwordHash,
        googleUser.picture || null,
        googleUser.sub,
        config.freeMonthlyCredits,
        stamp,
        stamp,
      )
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    }

    const user = sanitizeUser(row)
    res.json({ user, token: signToken(user) })
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { message: err.message, type: 'auth_error' } })
    }
    next(err)
  }
})

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})

/* ── Account settings: change email / password ─────────────────────────────
   Both re-prove the CURRENT password, so a stolen JWT alone can't lock the
   owner out by swapping the email or password. The token is keyed on the user
   id (requireAuth looks up by `sub`, never the email claim), so changing the
   email never invalidates the caller's existing token — we still hand back a
   freshly-signed one so the client can keep the email claim in sync. */
const changeEmailSchema = z.object({
  currentPassword: z.string().min(1),
  email: z.string().trim().email().max(160),
})

router.post('/email', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const body = changeEmailSchema.parse(req.body)
    const db = getDb()
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    const ok = await bcrypt.compare(body.currentPassword, row.password_hash)
    if (!ok) {
      return res.status(401).json({ error: { message: 'Current password is incorrect', type: 'auth_error' } })
    }
    const email = body.email.toLowerCase()
    if (email !== row.email) {
      const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, req.user.id)
      if (taken) {
        return res.status(409).json({ error: { message: 'That email is already in use', type: 'conflict' } })
      }
      db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(email, nowIso(), req.user.id)
    }
    const updated = sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id))
    res.json({ user: updated, token: signToken(updated) })
  } catch (err) {
    next(err)
  }
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(128),
})

router.post('/password', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const body = changePasswordSchema.parse(req.body)
    const db = getDb()
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
    const ok = await bcrypt.compare(body.currentPassword, row.password_hash)
    if (!ok) {
      return res.status(401).json({ error: { message: 'Current password is incorrect', type: 'auth_error' } })
    }
    const hash = await bcrypt.hash(body.newPassword, 10)
    /* Rotating the password is the "someone may have my account" moment: stamp a
       session floor so every token issued BEFORE now stops working (an attacker's
       stolen token dies), then mint a fresh one — its iat is at/after the floor, so
       the person who just proved the old password stays signed in. The client must
       adopt the returned token. */
    const stamp = nowIso()
    db.prepare('UPDATE users SET password_hash = ?, tokens_valid_after = ?, updated_at = ? WHERE id = ?')
      .run(hash, stamp, stamp, req.user.id)
    const updated = sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id))
    res.json({ user: updated, token: signToken(updated) })
  } catch (err) {
    next(err)
  }
})

export default router
