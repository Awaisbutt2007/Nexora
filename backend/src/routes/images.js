import { Router } from 'express'
import { fetchGeneratedImage, isNsfwPrompt } from '../services/images.js'

const router = Router()

/* Clamp a requested dimension into a sane band so nobody asks for a 8000² image
   and pins the server while Pollinations renders it. 1024 is the Flux-native
   resolution and the default, so the band brackets it (Flux degrades above it). */
const clampInt = (raw, fallback) => {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(1440, Math.max(256, Math.round(n))) : fallback
}

/* GET /api/images/generate?prompt=… — the ONE image endpoint the chat and the
   Image Generator tool point at. It exists so a Pollinations token never reaches
   the browser, and so a rate-limited generation returns an HONEST error instead
   of Pollinations' "at its limit" card being rendered as a fake success.

   We ALWAYS generate server-side and stream the bytes back from this same origin.
   The old tokenless path did a 302-redirect straight to Pollinations so the hit
   came from the user's own IP — but the browser sends cross-site `Origin`/
   `Referer`/`Sec-Fetch-*` headers that Pollinations (Cloudflare) rejects with a
   403, while a plain server-side `fetch` from this same host returns 200 image/*.
   Proxying keeps the <img> request same-origin (no referrer/CORS rejection),
   keeps the token server-side, and lets our retry loop own the failure. */
router.get('/generate', async (req, res, next) => {
  try {
    const prompt = String(req.query.prompt || '').trim().slice(0, 900)
    if (!prompt) {
      return res.status(400).json({ error: { message: 'A prompt is required.', type: 'invalid_request_error' } })
    }
    if (isNsfwPrompt(prompt)) {
      return res.status(400).json({ error: { message: 'Adult/NSFW content is not allowed on Nexora.', type: 'invalid_request_error' } })
    }
    const width = clampInt(req.query.width, 1024)
    const height = clampInt(req.query.height, 1024)

    const { buffer, contentType } = await fetchGeneratedImage(prompt, { width, height })
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(buffer)
  } catch (err) {
    if (res.headersSent) return next(err)
    res.status(err.status || 502).json({
      error: { message: err.message || 'Image generation failed.', type: 'image_unavailable' },
    })
  }
})

export default router
