import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import cors from 'cors'
import express from 'express'
import { config } from './config.js'
import { getDb } from './db/index.js'
import { requireAuth } from './middleware/auth.js'
import { errorHandler, notFound } from './middleware/error.js'
import authRoutes from './routes/auth.js'
import billingRoutes from './routes/billing.js'
import chatRoutes from './routes/chat.js'
import conversationRoutes from './routes/conversations.js'
import desktopRoutes from './routes/desktop.js'
import desktopAgentRoutes from './routes/desktopAgent.js'
import imageRoutes from './routes/images.js'
import memoryRoutes from './routes/memory.js'
import realtimeRoutes from './routes/realtime.js'
import scheduleRoutes from './routes/schedule.js'
import toolsRoutes from './routes/tools.js'
import userRoutes from './routes/user.js'
import voiceRoutes from './routes/voice.js'

fs.mkdirSync(config.uploadsDir, { recursive: true })
getDb()

const app = express()

/* Behind a reverse proxy, trust the first hop so req.ip (used by the auth rate
   limiter) is the real client, not the load balancer. Off by default in local dev. */
app.set('trust proxy', config.trustProxy ? 1 : false)

/* CORS is an exact origin list in production, but in development a request from any
   local origin is allowed too — see config.corsAllowLocalOrigins for why an unlisted
   origin is indistinguishable from a broken login on the client. */
const corsAllowlist = config.corsOrigin === '*' ? null : config.corsOrigin.split(',').map((s) => s.trim())
// localhost / 127.x.x.x / ::1, plus the RFC 1918 ranges a dev LAN lives in.
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|\[::1\]|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{2,5})?$/

app.use(
  cors({
    // cors v2 hands the custom resolver the request's Origin STRING, not the request.
    origin: (origin, callback) => {
      // No Origin header = not a CORS request (same-origin, curl, server-to-server).
      if (!origin) return callback(null, false)
      if (!corsAllowlist) return callback(null, true)
      if (corsAllowlist.includes(origin)) return callback(null, true)
      return callback(null, Boolean(config.corsAllowLocalOrigins && LOCAL_ORIGIN.test(origin)))
    },
    credentials: true,
    exposedHeaders: ['X-Conversation-Id'],
  }),
)
app.use(express.json({ limit: '2mb' }))

/* Voice prints are sensitive biometric-adjacent audio. Unlike a chat image — which a
   plain <img> must be able to load with no Authorization header, so it stays on the
   public static route below — nothing in the app ever reads a voice SAMPLE back from
   the browser (the print list only shows metadata; the bytes are used server-side for
   the embedding). So they must NOT sit on the unauthenticated static route where
   anyone holding the (unguessable, but leakable via logs/referrer/history) filename
   could pull them. This guard runs BEFORE the static handler and intercepts only
   voice_* files: the caller must be authenticated AND own the print per the DB, so
   one user can never fetch another's sample. Every other upload (img_*) falls through
   to express.static untouched. */
const VOICE_FILE = /^voice_[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/
app.get('/uploads/:name', (req, res, next) => {
  if (!VOICE_FILE.test(req.params.name)) return next()
  requireAuth(req, res, () => {
    const owner = getDb()
      .prepare('SELECT user_id FROM voice_prints WHERE sample_path = ?')
      .get(`uploads/${req.params.name}`)
    if (!owner || owner.user_id !== req.user.id) {
      return res.status(404).json({ error: { message: 'Not found', type: 'not_found' } })
    }
    res.sendFile(path.join(config.uploadsDir, req.params.name))
  })
})

/* User-attached reference images are saved under uploads/ with unguessable
   nanoid names and served straight from here — plain <img src> tags cannot
   send an Authorization header. The files themselves stay outside /api. */
app.use('/uploads', express.static(config.uploadsDir, { index: false, maxAge: '7d' }))

/* Baseline security headers. JSON responses get the strict set; the hosted client build
   (below) is our own HTML and is never framed, so the same headers are harmless there. */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')
  if (config.nodeEnv === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})

/* One-process mode: when a production build exists, this server also hosts the web app.
   A page loaded from here then calls RELATIVE /api and /uploads URLs, so frontend and API
   share a single origin and no CORS rule can ever break a request — the failure class that
   surfaced as "Failed to fetch" while creating an account. In dev Vite proxies /api itself
   (vite.config.js) and never reaches this branch. The static mount sits above the `/` JSON
   route below, so with a build present `/` serves the app and without one it serves docs. */
if (config.hostClient && fs.existsSync(path.join(config.clientDir, 'index.html'))) {
  app.use(express.static(config.clientDir, { index: 'index.html', extensions: ['html'] }))
  // Client-side page (DownloadPage.jsx) — serve the app shell for it.
  app.get('/download', (_req, res) => res.sendFile(path.join(config.clientDir, 'index.html')))
}

app.get('/health', (_req, res) => {
  /* Readiness, not a parts list. This route answers without a token, and it used to
     print the live chat model, the voice model and which vendor the key belongs to —
     i.e. anyone who thought to look got the answer to the one question the companion
     is built to keep private: "how were you made?". The operator can still ask for the
     plumbing with HEALTH_VERBOSE=1 (off by default, so a public deploy cannot forget
     to turn it off). A Groq-style key speaks the OpenAI chat format but has NO realtime
     voice endpoint, so it powers text chat yet can never place a call — that is reported
     as a reason, never as a vendor name. */
  const groqKey = /^gsk_/.test(config.openaiApiKey) || /groq\.com/i.test(config.openaiBaseUrl || '')
  const voiceReport = !config.openaiApiKey
    ? 'unavailable (no AI key configured on this server)'
    : groqKey ? 'unavailable (this key cannot do realtime voice)' : 'ready'
  const body = {
    status: 'ok',
    service: 'nexora-backend',
    time: new Date().toISOString(),
    ai: config.openaiApiKey ? (groqKey ? 'text-only' : 'live') : 'mock',
    voice: voiceReport,
  }
  if (process.env.HEALTH_VERBOSE === '1') {
    body.aiProvider = config.openaiBaseUrl
    body.model = config.openaiModel
    body.voiceProvider = config.voiceProvider
    body.voiceModel = config.voiceRealtimeModel
  }
  res.json(body)
})

app.get('/', (_req, res) => {
  res.json({
    name: 'Nexora API',
    version: '1.0.0',
    docs: {
      health: 'GET /health',
      auth: ['POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me'],
      chat: 'POST /api/chat/completions  { message, stream?, conversationId? }',
      conversations: 'GET|POST /api/conversations',
      memory: 'GET|POST /api/memory',
      tools: 'GET /api/tools  |  POST /api/tools/:toolId/run',
      images: 'GET /api/images/generate?prompt=…  (streams a generated image, or redirects straight to the provider when no token is set)',
      desktop: 'GET /api/desktop/health | POST /api/desktop/intent | POST /api/desktop/plan | POST /api/desktop/execute | POST /api/desktop/stop',
      desktopAgent: 'GET /api/desktop-agent/entitlement  (local agent verifies a paid account before pairing)',
      user: 'GET /api/user/profile  |  POST /api/user/upgrade',
      billing: 'GET /api/billing/status | POST /api/billing/request  (manual Easypaisa/JazzCash) | GET /api/billing/requests | POST /api/billing/review  (admin)',
      voice: 'POST /api/voice/enroll  |  POST /api/voice/verify  |  GET|DELETE /api/voice/prints',
      realtime: 'POST /api/voice/realtime/token  |  POST /api/voice/realtime/turn',
    },
  })
})

app.use('/api/auth', authRoutes)
app.use('/api/billing', billingRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/conversations', conversationRoutes)
app.use('/api/memory', memoryRoutes)
app.use('/api/schedule', scheduleRoutes)
app.use('/api/desktop', desktopRoutes)
app.use('/api/desktop-agent', desktopAgentRoutes)
app.use('/api/images', imageRoutes)
app.use('/api/tools', toolsRoutes)
app.use('/api/user', userRoutes)
app.use('/api/voice/realtime', realtimeRoutes)
app.use('/api/voice', voiceRoutes)

app.use(notFound)
app.use(errorHandler)

export { app }

/* Only bind a port when this file is the entry point (`node src/index.js` /
   `npm run dev`). Importing `app` from the test suite starts it on an ephemeral
   port instead, so the automated tests never fight the dev server for :8787. */
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  const server = app.listen(config.port, config.host, () => {
    console.log(`Nexora backend listening on http://localhost:${config.port}`)
    console.log(`AI mode: ${config.openaiApiKey ? `OpenAI (${config.openaiModel})` : 'mock streaming (set OPENAI_API_KEY)'}`)
  })
  /* A second copy dying silently in an unwatched terminal is how a stale instance ends up
     owning :8787 while the user believes the fresh one is live. Say it out loud. */
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err
    console.error(`Port ${config.port} is already in use — another Nexora backend is serving it.`)
    console.error('That running copy answers the app, so nothing is broken; to start this one')
    console.error('instead, close the other terminal first (or set PORT in backend/.env).')
    process.exit(1)
  })
}
