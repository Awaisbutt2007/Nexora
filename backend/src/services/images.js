/**
 * Image generation. The workspace has no paid image key (the chat runs on a free
 * Groq tier and the OpenAI key is quota-exhausted), so we use Pollinations — a
 * real, keyless image model — instead of the old mock placeholder. The endpoint
 * derives a picture straight from the URL, so we only ever build a URL here.
 *
 * Provider is kept in one place so a funded DALL·E / Flux key can replace it
 * later without touching routes or the UI.
 */

import OpenAI from 'openai'
import { config } from '../config.js'

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* Filler words that are meta-language about the REQUEST, not the SUBJECT.
 * Stripped before the text reaches the image model. Covers English, Roman
 * Urdu, and common abbreviations. */
const FILLER = new Set([
  'ka', 'ki', 'ke', 'kiya', 'kiya', 'muja', 'mujhe', 'mujy', 'mera', 'meri', 'mere',
  'pir', 'par', 'pr', 'or', 'aur', 'b', 'bh', 'bhi', 'kar', 'karo', 'kara',
  'sakte', 'sakti', 'sakta', 'can', 'could', 'please', 'pls', 'kindly',
  'to', 'for', 'me', 'my', 'do', 'de', 'dijiye', 'dena', 'dena', 'banwa',
  'related', 'relate', 'se', 'say', 'from', 'with', 'without', 'about',
  'something', 'kuch', 'kuchh', 'jaisa', 'jaise', 'aisa', 'waisa',
  'caption', 'captions', 'text', 'heading', 'title',
  'generate', 'create', 'make', 'draw', 'design', 'render', 'paint', 'sketch',
  'bana', 'bna', 'banao', 'banado', 'ban', 'de', 'do', 'dikha', 'dekhao',
  'image', 'img', 'picture', 'pic', 'pics', 'photo', 'photograph', 'tasveer', 'tasvir',
  'poster', 'logo', 'wallpaper', 'illustration', 'artwork', 'drawing',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
])

/**
 * Heuristic prompt refinement — strips action verbs, image nouns, and filler
 * words from the user's raw message, leaving the SUBJECT. If the result is
 * too short, falls back to the original text.
 *
 * Example: "coding ka related pir muja image bana do or us ka caption b"
 *       → "coding" (the subject the image model should draw)
 */
export function refineImagePrompt(rawText) {
  if (!rawText || typeof rawText !== 'string') return rawText
  const t = rawText.trim().toLowerCase()
  /* Split on "or" / "aur" (and) to isolate the image request from extra asks
     like "caption b" (caption too). Take the first segment. */
  const firstSegment = t.split(/\s+(?:or|aur)\s+/)[0] || t
  /* Tokenize on whitespace and punctuation, keep only meaningful words. */
  const tokens = firstSegment.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const subject = tokens.filter((w) => w.length > 1 && !FILLER.has(w))
  const result = subject.join(' ').trim()
  /* If the heuristic stripped everything (user said just "make image"), use
     the original text — the image model can still try to interpret it. */
  return result.length >= 3 ? result : rawText.trim()
}

/**
 * Expand a thin extracted subject into a rich illustration prompt. A one- or
 * two-word prompt like "coding" is ambiguous — Flux reads short abstract nouns
 * as portrait subjects and defaults to a person (the "coding → girl photo"
 * bug). Describing the SUBJECT MATTER (screens, code, icons) plus an explicit
 * "no people" clause steers the model away from portraits. Long, already-
 * descriptive prompts pass through untouched.
 */
export function enrichImagePrompt(subject) {
  const s = String(subject || '').trim()
  if (!s) return s
  /* Already detailed (a real scene description) — trust it. */
  if (s.split(/\s+/).length > 6) return s
  /* Tech/programming topics: depict the artifacts (editors, terminals, UIs),
     never a person at a keyboard — Flux loves "developer girl" portraits. The
     quality tail (sharp focus, high detail, cinematic lighting, 4k) is what
     pushes Flux past the soft, flat look the user complained about; the old
     "dark background" made everything muddy, so it is gone. */
  /* Only genuinely ABSTRACT programming topics get the code-editor scene. Concrete
     subjects that merely sound "techy" (a robot, a game character, an app icon) are
     things to draw, not screens — "a cute robot waving" must stay a waving robot. */
  if (TECH_TOPIC_RE.test(s) && !PEOPLE_RE.test(s)) {
    return `${s} concept illustration, a glowing code editor window with colorful syntax-highlighted source code lines and a terminal window with running commands, software developer tools, keyboard and monitor, crisp sharp focus, intricate detail, professional digital art, vibrant colors, cinematic lighting, clean softly-lit background, 4k, high resolution, no people, no faces, no watermark`
  }
  /* Respect a style the user named (anime, photo, watercolor…) instead of forcing
     "illustration", and never forbid people when people ARE the subject. */
  const lead = STYLE_RE.test(s) ? `beautiful highly detailed ${s}` : `beautiful highly detailed illustration of ${s}`
  /* "no people" (not "no faces": a robot or a cat still needs one) keeps a thin
     abstract prompt from collapsing into a random portrait. */
  const people = PEOPLE_RE.test(s) ? '' : ', no people'
  return `${lead}, crisp sharp focus, vibrant colors, professional quality, cinematic lighting, clean background, 4k, high resolution${people}, no text, no watermark`
}

const TECH_TOPIC_RE = /^\s*(?:(?:a|an|the)\s+)?(?:coding|code|programming|program|developer|software(?:\s+development)?|web\s+development|python|javascript|java|js|html|css|react|api|database|tech|technology)\b/i
const PEOPLE_RE = /\b(?:person|people|man|men|woman|women|girl|girls|boy|boys|child|children|kid|kids|baby|family|couple|lady|guy|portrait|face|selfie|human|friends?|mother|father|mom|dad|bride|groom|student|teacher|doctor|player|warrior|princess|prince|king|queen)\b/i
const STYLE_RE = /\b(?:anime|manga|cartoon|photo|photograph|photorealistic|realistic|watercolor|watercolour|oil\s+painting|painting|sketch|pencil|3d|render|pixel|vector|logo|icon|illustration|digital\s+art|comic|chibi|minimalist)\b/i

/**
 * LLM-based prompt refinement — for complex or ambiguous requests where the
 * heuristic can't extract a clean English subject. Sends the raw text to the
 * chat model with a system prompt asking for a concise English image prompt.
 * Falls back to the heuristic (and then the raw text) on any error.
 */
export async function refineImagePromptWithLlm(rawText) {
  const heuristic = refineImagePrompt(rawText)
  /* If the heuristic produced a clean English result, trust it — no LLM cost. */
  if (heuristic && heuristic.length >= 4 && /^[\u0020-\u007E]+$/.test(heuristic)) {
    return enrichImagePrompt(heuristic)
  }
  /* Otherwise ask the LLM to produce a clean English prompt. */
  if (!config.openaiApiKey) return enrichImagePrompt(heuristic) || rawText
  try {
    const client = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.openaiBaseUrl })
    const completion = await client.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: 'You convert a user\'s image request (which may be in English, Roman Urdu, Hindi, or mixed) into a single concise English prompt that describes ONLY what the image should visually show. Strip all meta-language about the request itself ("make", "generate", "image", "bana do", "caption", etc.). Output ONLY the English description, no preamble, no quotes, max 25 words.' },
        { role: 'user', content: rawText },
      ],
      max_tokens: 80,
      temperature: 0.2,
    }, { maxRetries: 0 })
    const refined = completion.choices[0]?.message?.content?.trim()
    return refined ? enrichImagePrompt(refined) : (enrichImagePrompt(heuristic) || rawText)
  } catch {
    /* Rate limit, network error, etc. — fall back to the heuristic result. */
    return enrichImagePrompt(heuristic) || rawText
  }
}


/* Requests that clearly want a picture. We require BOTH an action verb and an
   image noun so ordinary chat ("I have a picture in mind") is not hijacked.
   Covers English, Roman Urdu and Urdu script. */
const ACTION = /(bana|bna|banao|banado|ban\s?de|ban\s?do|kar\s?do|generate|create|make|draw|design|render|paint|sketch|imagine|dikha|dekhao|chahye|chaheye|chahiye|want|need)/i
const SUBJECT = /(image|img|picture|\bpics?\b|photo|photograph|tasveer|tasvir|poster|logo|wallpaper|illustration|artwork|drawing|عکس|تصویر|تصاویر)/i

/* Adult-content guard. Nexora is a all-ages product, so any image prompt that
   reads as sexual/nudity is refused before it ever reaches the model. The
   provider's own `safe=true` filter is a paid feature (returns 402), so the
   blocklist is the real gate. Matches English, Roman Urdu and Urdu script. */
const NSFW = /(nude|naked|nudity|nsfw|porn|porno|pornstar|sex|sexual|sexy|erotic|xxx|adult\s?video|hentai|boob|boobs|tit|tits|penis|vagina|breast|nipple|ass|butt|buttocks|anal|blowjob|handjob|orgasm|cum|slut|whore|strip(tease)?|topless|bra\b|lingerie|underwear|underpants|see[\s-]?through|wet[\s-]?t[\s-]?shirt|bikini|swimsuit|cleavage|genital|negligee|onlyfans|boudoir|make\s?love|bedroom\s?scene|kamuk|kaamo?kas|kamsutra|chudai|chudai?|chod|bhosra|bhosda|randi|haraami|lund|laura|gand|moot|nangi|nanga|nange|kapde?\s?(utaar|nikal|ke)?|without\s?clothes|half[\s-]?naked|bikini|chuchi|chuche|jism|jismani|shahwat|shervani|عورت\s?ki\s?nangi|ننگی|نangat|فحش|جنسی|عریا)/i

/** True when a prompt looks like adult/NSFW content that must be blocked. */
export function isNsfwPrompt(text) {
  return !!text && NSFW.test(String(text))
}

/* "Show me YOUR face / YOUR settings" is a demand to see the app's own live UI, not
   a picture to draw. Those are answered by the client capturing a real screenshot of
   itself (see src/selfCapture.js), so the generator must never hijack them — it used
   to reply with a made-up Pollinations portrait when the user asked to see her real
   face, which is exactly the dishonesty the user complained about. Both halves must
   match: a possessive pointing at HER, plus one of her own surfaces. */
const SELF_OWNER = /\b(apna|apni|apne|apsa|tumhara|tumhari|tumhare|tumhare|tera|teri|terey|teree|aapka|aapki|aapke|your|yours|self|khud|khud|apni\s?hi)\b/i
const SELF_UI = /\b(chehra|chehry|chehray|shakal|soorat|surat|face|avatar|profile\s?pic|dp|setting|settings|screen|screenshot|ui|interface|page|memory|memories|yaadein|yaaden|roop|look|appearance)\b/i

/** True when the user is asking the assistant to reveal its OWN face or UI. */
export function isSelfUiRequest(text) {
  if (!text || typeof text !== 'string') return false
  const t = text.trim()
  return !!t && SELF_OWNER.test(t) && SELF_UI.test(t)
}

/** Returns the prompt to draw, or null when the message is not an image request. */
export function detectImageRequest(text) {
  if (!text || typeof text !== 'string') return null
  const t = text.trim()
  if (!t) return null
  return ACTION.test(t) && SUBJECT.test(t) ? t : null
}

/**
 * Build the real, loadable Pollinations URL from a text prompt. Renders at
 * 1024² — Flux is TRAINED at 1024, so the old 768² came out soft and low-detail
 * (the "image quality is poor" complaint). `enhance=true` lets the model
 * enrich the prompt for extra detail, and `nologo` drops the watermark. When a
 * `POLLINATIONS_TOKEN` is configured it is appended here — so this function must
 * ONLY ever be called server-side (the proxy), never handed to the browser.
 */
export function buildImageUrl(prompt, { width = 1024, height = 1024 } = {}) {
  const clean = String(prompt || '').trim().slice(0, 900) || 'a beautiful scene'
  const params = new URLSearchParams({ width: String(width), height: String(height), nologo: 'true', model: 'flux', enhance: 'true' })
  if (config.pollinationsToken) params.set('token', config.pollinationsToken)
  return `${POLLINATIONS_BASE}${encodeURIComponent(clean)}?${params.toString()}`
}

/**
 * The client-facing path for a generated image. Both the chat and the Image
 * Generator tool embed THIS (never buildImageUrl) so the token stays on the
 * server and a rate-limited generation surfaces as an honest error rather than
 * Pollinations' "at its limit" card being rendered as a fake success.
 */
export function imageProxyPath(prompt, { width = 1024, height = 1024 } = {}) {
  const clean = String(prompt || '').trim().slice(0, 900) || 'a beautiful scene'
  return `/api/images/generate?prompt=${encodeURIComponent(clean)}&width=${width}&height=${height}`
}

/**
 * Generate server-side with retry. The free anonymous tier sheds most traffic
 * with 402/429/503; a configured token answers reliably. Resolves to
 * `{ buffer, contentType }` on a real image, or throws an Error carrying
 * `.status` so the route can report an honest failure (never a placeholder).
 */
export async function fetchGeneratedImage(prompt, { width = 1024, height = 1024, attempts = 4 } = {}) {
  const url = buildImageUrl(prompt, { width, height })
  let lastStatus = 502
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url)
      const ctype = res.headers.get('content-type') || ''
      if (res.ok && ctype.startsWith('image/')) {
        return { buffer: Buffer.from(await res.arrayBuffer()), contentType: ctype }
      }
      lastStatus = res.status || 502
      if (i < attempts) {
        const ra = Number(res.headers.get('retry-after'))
        await sleep(Math.min(12000, ra > 0 ? ra * 1000 : 2000 * i))
      }
    } catch {
      lastStatus = 502
      if (i < attempts) await sleep(2000 * i)
    }
  }
  const err = new Error('The image service is busy right now — please try again in a moment.')
  err.status = lastStatus === 402 ? 503 : (lastStatus || 502)
  err.retryable = true
  throw err
}
