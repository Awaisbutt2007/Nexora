import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { config, REPLY_LANGUAGES } from '../config.js'
import { getDb, nowIso } from '../db/index.js'
import { requireAuth } from '../middleware/auth.js'
import { ensureCredits, deductCredits } from '../services/credits.js'
import {
  cosineSimilarity,
  deserializeEmbedding,
  extractEmbedding,
  serializeEmbedding,
} from '../services/voice.js'
import { isTtsAvailable, pickTtsVoice, synthesizeSpeech } from '../services/tts.js'

const router = Router()
router.use(requireAuth)

/* Browser MediaRecorder sends webm/opus; WAV and MP4 are accepted for other clients. */
const ALLOWED_EXT = new Set(['.webm', '.wav', '.mp4', '.m4a', '.ogg'])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})

const enrollSchema = z.object({
  label: z.string().trim().max(80).optional(),
})

function saveSample(buffer, originalName) {
  const ext = ALLOWED_EXT.has(path.extname(originalName || '').toLowerCase())
    ? path.extname(originalName).toLowerCase()
    : '.webm'
  const fileName = `voice_${nanoid(16)}${ext}`
  const filePath = path.join(config.uploadsDir, fileName)
  fs.writeFileSync(filePath, buffer)
  return { fileName, filePath }
}

function printRow(row) {
  return {
    id: row.id,
    label: row.label || null,
    samplePath: row.sample_path,
    createdAt: row.created_at,
  }
}

/* List the caller's enrolled voice prints (no embedding bytes). */
router.get('/prints', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT id, label, sample_path, created_at FROM voice_prints
       WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(req.user.id)
  res.json({ object: 'list', data: rows.map(printRow) })
})

/* Enroll: save the recording under uploads/ and store its embedding as a BLOB. */
router.post('/enroll', upload.single('sample'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({
        error: { message: 'Multipart field "sample" (audio recording) is required', type: 'invalid_request_error' },
      })
    }
    const body = enrollSchema.parse(req.body || {})

    const { fileName, filePath } = saveSample(req.file.buffer, req.file.originalname)
    let embedding
    try {
      embedding = await extractEmbedding(filePath)
    } catch (err) {
      fs.unlinkSync(filePath)
      throw err
    }

    const id = `vpr_${nanoid(16)}`
    const stamp = nowIso()
    getDb()
      .prepare(
        `INSERT INTO voice_prints (id, user_id, label, embedding, sample_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, req.user.id, body.label || null, serializeEmbedding(embedding), `uploads/${fileName}`, stamp)

    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM voice_prints WHERE user_id = ?')
      .get(req.user.id).n

    res.status(201).json({
      id,
      label: body.label || null,
      samplePath: `uploads/${fileName}`,
      dimensions: embedding.length,
      printsEnrolled: count,
      createdAt: stamp,
    })
  } catch (err) {
    next(err)
  }
})

/* Verify: compare a live sample against every stored print, best score wins. */
router.post('/verify', upload.single('sample'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({
        error: { message: 'Multipart field "sample" (audio recording) is required', type: 'invalid_request_error' },
      })
    }

    const prints = getDb()
      .prepare('SELECT id, embedding FROM voice_prints WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.user.id)
    if (prints.length === 0) {
      return res.status(404).json({
        error: { message: 'No voice print enrolled for this user', type: 'not_found' },
      })
    }

    const { filePath } = saveSample(req.file.buffer, req.file.originalname)
    let probe
    try {
      probe = await extractEmbedding(filePath)
    } catch (err) {
      fs.unlinkSync(filePath)
      throw err
    }
    /* The verify probe is only used for its embedding; keep uploads/ clean. */
    fs.unlinkSync(filePath)

    let bestScore = -1
    let bestId = null
    for (const print of prints) {
      const score = cosineSimilarity(probe, deserializeEmbedding(print.embedding))
      if (score > bestScore) {
        bestScore = score
        bestId = print.id
      }
    }

    const threshold = config.voiceMatchThreshold
    res.json({
      matched: bestScore >= threshold,
      confidence: Math.round(bestScore * 1000) / 1000,
      threshold,
      matchedPrintId: bestScore >= threshold ? bestId : null,
      printsCompared: prints.length,
      dimensions: probe.length,
    })
  } catch (err) {
    next(err)
  }
})

/* Delete one of the caller's voice prints and its stored sample. */
router.delete('/prints/:id', (req, res, next) => {
  try {
    const row = getDb()
      .prepare('SELECT id, sample_path FROM voice_prints WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)
    if (!row) {
      return res.status(404).json({ error: { message: 'Voice print not found', type: 'not_found' } })
    }

    getDb().prepare('DELETE FROM voice_prints WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id)
    if (row.sample_path) {
      const sampleFile = path.join(config.rootDir, row.sample_path)
      if (fs.existsSync(sampleFile)) fs.unlinkSync(sampleFile)
    }
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

/* ── Server-side TTS (POST /api/voice/synth) ───────────────────────────────
 * The chat's auto-spoken reply is routed here FIRST so a Hinglish / Roman Urdu
 * answer is read by OpenAI's multilingual speech engine (`gpt-4o-mini-tts`) —
 * the same family of voices Talk calls use — instead of the OS's English-only
 * `speechSynthesis`. If the server has no OpenAI key (e.g. a Groq-only install
 * like the current dev .env), we return a clean 503 `tts_unavailable` and the
 * client transparently falls back to the browser-TTS pipeline, which is already
 * wired to the accent-preference chain in voiceSelect.js. The user never sees a
 * silent failure, and the moment a real OpenAI key is dropped into .env the
 * richer audio lights up without any client change.
 *
 * Text is stripped of markdown + emoji before it reaches us (see
 * speakAssistantReply in the client), so what we forward is already plain
 * spoken text. Cap at 1200 chars to bound provider cost per call. */
const synthSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  /* Optional hint at the reply's language; not sent to the provider (its
     engine auto-detects) but logged and forwarded to the pick so future
     per-language voice preferences can hang off it without a schema change. */
  language: z.enum(REPLY_LANGUAGES).optional().default('auto'),
  gender: z.enum(['female', 'male']).optional(),
  /* Explicit provider voice name (alloy/echo/fable/onyx/nova/shimmer). When
     absent or unknown we pick by gender. Never trusted as-is: filtered via
     pickTtsVoice's allow-list below. */
  voice: z.string().trim().max(20).optional(),
  /* Names spoken in this reply (assistant + user). The engine reads a
     South-Asian name through its English phoneme table ("Awais" → "AY-waze"
     → "a-waze"); known names are respelled in the text pass and anything
     outside that small table rides along here so the style spec can tell the
     voice how to say it. Capped hard — this is a hint list, not a payload. */
  names: z.array(z.string().trim().min(1).max(40)).max(4).optional(),
})

router.post('/synth', async (req, res, next) => {
  try {
    const body = synthSchema.parse(req.body || {})
    /* Fail-fast on un-configured provider so the client can pick its fallback
       without waiting on a network round trip that we already know will fail. */
    if (!isTtsAvailable()) {
      return res.status(503).json({
        error: {
          message: 'Server-side voice is not configured on this server — it has no OpenAI speech key, so the reply will be read by your device voice instead.',
          type: 'tts_unavailable',
        },
      })
    }
    /* Charge 1 credit per 200 chars (rounded up), minimum 1, cap 6 by the schema
       length rule. Same style as chat's estimateCredits so it slots into the
       existing credit accounting and premium-unlimited path in deductCredits. */
    const cost = Math.max(1, Math.ceil(body.text.length / 200))
    ensureCredits(req.user, cost)
    const voice = pickTtsVoice({ voice: body.voice, gender: body.gender, language: body.language })
    /* Charge credits based on the CLIENT's original text length so phonetic
       rewrites (`kyun` → `kayun`) that slightly expand the string can't be
       gamed into a lower cost-per-character. The provider still sees the
       prepared text inside `synthesizeSpeech`. */
    /* Names the companion is about to say out loud: the account's own name
       ("Haan Awais, …") plus the assistant name from the stored prefs, so a
       Settings rename is pronounced correctly without a deploy. Instruction-only
       names (e.g. "Awais") stay in natural spelling and get an explicit
       English-pronunciation instruction; other known names get GPM respelling.
       The hint also fires from TEXT scanning inside buildTtsInstructions, so
       ALL mentions are covered (developer name, addressing user, etc.). */
    const names = [req.user.name, req.user.prefs?.assistantName]
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => n.trim().split(/\s+/)[0].slice(0, 40))
    const buffer = await synthesizeSpeech({ text: body.text, voice, language: body.language, gender: body.gender, names })
    deductCredits(req.user.id, cost)
    /* Stream the MP3 back same-origin. No Cache-Control: public because replay
       of an identical reply is rare and each credit-charged call should be
       visible in the server log. `no-store` also stops the browser caching
       voice audio across logout. */
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Credits-Charged', String(cost))
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})

export default router
