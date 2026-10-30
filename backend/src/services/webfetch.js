/**
 * Server-side web reading.
 *
 * WHY THIS EXISTS. When a user pastes a link ("ye link view karo, taaka tumhe
 * patta chale Claude kya hai"), the chat model used to answer "Main live browser
 * nahi khol sakti" — because the cloud provider behind it genuinely cannot open
 * a browser, and the local desktop agent's `browser.open` only SHOWS a page to
 * the user, it never reads the content back into the conversation. So the AI
 * could never actually talk about a link it was given.
 *
 * This module closes that gap the honest way: when the user's message contains a
 * public http(s) URL, the SERVER fetches it, strips it down to readable text and
 * hands that text to the model as context for this turn. No browser, no local
 * agent required — the AI "sees" the page and can discuss it.
 *
 * SECURITY (SSRF). The backend can reach things the open internet cannot (itself,
 * the loopback desktop agent, cloud metadata). So a fetched URL is confined to
 * http(s) and to a PUBLIC host: loopback, private (RFC 1918), link-local
 * (169.254 — the metadata endpoint) and the IPv6 equivalents are all refused, and
 * every redirect hop is re-validated because a public URL is free to bounce to
 * 127.0.0.1. Binary/oversized/non-HTML bodies are dropped. Everything degrades to
 * an empty context on failure — a dead link must never break the chat.
 */

import { config } from '../config.js'

const MAX_URLS = 2
const PER_URL_CHARS = 4200
const TOTAL_CHARS = 7000
const MAX_BYTES = 700_000
const TIMEOUT_MS = Number(config.webFetchTimeoutMs || 8000)
const MAX_REDIRECTS = 3

/* Bare http(s) URL. Stops at whitespace and the common closing punctuation that
   is almost never part of a URL; trailing .,;:!?)] are trimmed afterwards. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi

/* Hostnames that must never be fetched even though they resolve publicly in a
   normal setup. `metadata.google.internal` and friends are caught by the IP and
   suffix checks below too, but naming them keeps intent obvious. */
const BLOCKED_HOST_RE = /^(localhost|.*\.localhost|.*\.internal|.*\.local|metadata|\[::1\]|\[fd[0-9a-f:]*\])$/i

/** Find, de-duplicate and clean the http(s) URLs a message mentions. */
export function extractUrls(text) {
  if (!text || typeof text !== 'string') return []
  const seen = new Set()
  const out = []
  for (const raw of text.match(URL_RE) || []) {
    /* Trailing punctuation that clung to the match, and an unbalanced trailing
       ")" from markdown/prose like "[title](url)". */
    let u = raw.replace(/[),.;:!?]+$/, '')
    if ((u.match(/\(/g) || []).length > (u.match(/\)/g) || []).length) u = u.replace(/\)+$/, '')
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}

/** True for IPv4/IPv6 literals that point at the machine or its private corner. */
function isPrivateIp(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (/^127\./.test(h)) return true /* 127.0.0.0/8 loopback */
  if (/^10\./.test(h)) return true /* 10.0.0.0/8 */
  if (/^192\.168\./.test(h)) return true /* 192.168.0.0/16 */
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true /* 172.16.0.0/12 */
  if (/^169\.254\./.test(h)) return true /* link-local / cloud metadata */
  if (/^0\./.test(h)) return true /* "this" network */
  if (h === '::1' || h === '::') return true /* IPv6 loopback / unspecified */
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true /* IPv6 unique-local fc00::/7 */
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true /* IPv6 link-local fe80::/10 */
  /* IPv4-mapped IPv6 (::ffff:127.0.0.1) — recurse on the embedded v4. */
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (mapped) return isPrivateIp(mapped[1])
  return false
}

/** A URL is safe to fetch only if it is http(s) and its host is public. */
export function isSafeUrl(rawUrl) {
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname
  if (!host) return false
  if (BLOCKED_HOST_RE.test(host)) return false
  if (isPrivateIp(host)) return false
  return true
}

/* ---- HTML → readable text ------------------------------------------------ */

const ENTITY_MAP = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&ensp;': ' ', '&emsp;': ' ', '&thinsp;': ' ', '&shy;': '',
  '&ndash;': '-', '&mdash;': '-', '&copy;': '©', '&reg;': '®', '&trade;': '™',
  '&hellip;': '…', '&lsquo;': "'", '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
    })
    .replace(/&[a-z]+;/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m)
}

/** Pull the human-readable body text (plus title) out of an HTML document. */
export function htmlToText(html) {
  let t = String(html || '')
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(t)?.[1] || '').replace(/\s+/g, ' ').trim()

  t = t
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:head|nav|footer|header|form|aside)[\s\S]*?<\/(?:head|nav|footer|header|form|aside)>/gi, ' ')
    /* Block-ish boundaries become spaces so words don't glue together. */
    .replace(/<\/(?:p|div|li|br|h[1-6]|tr|td|th|section|article)>/gi, ' ')
    .replace(/<(?:br|hr)\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')

  t = decodeEntities(t).replace(/\s+/g, ' ').trim()
  return { title, text: t }
}

/* ---- fetch one page ------------------------------------------------------ */

async function fetchWithTimeout(url, signal) {
  return fetch(url, {
    redirect: 'manual',
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NexoraBot/1.0; +https://nexora.app)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      'Accept-Language': 'en,ur;q=0.8',
    },
  })
}

/**
 * Read one URL down to plain text. Follows up to MAX_REDIRECTS manual hops,
 * re-checking SSRF safety on each, and returns { url, title, text } or null for
 * anything unreadable (non-html, binary, too big, private, timed out, errored).
 */
export async function readUrl(rawUrl) {
  if (!config.webFetchEnabled) return null
  let current = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isSafeUrl(current)) return null
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    let res
    try {
      res = await fetchWithTimeout(current, ctrl.signal)
    } catch {
      clearTimeout(timer)
      return null
    }
    clearTimeout(timer)

    /* Manual redirect: validate the next target before following it. */
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      try {
        await res.body?.cancel()
      } catch { /* ignore */ }
      if (!loc) return null
      let next
      try {
        next = new URL(loc, current).toString()
      } catch {
        return null
      }
      if (!isSafeUrl(next)) return null
      current = next
      continue
    }

    if (!res.ok) {
      try {
        await res.body?.cancel()
      } catch { /* ignore */ }
      return null
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    /* Only read text-ish documents; skip images, pdf, octet-stream, json blobs. */
    if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) {
      try {
        await res.body?.cancel()
      } catch { /* ignore */ }
      return null
    }

    let body = ''
    try {
      /* Read as text but bail if the document is enormous. */
      body = await res.text()
    } catch {
      return null
    }
    if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES)

    const { title, text } = htmlToText(body)
    if (!text || text.length < 40) return null /* a shell page with no real content */
    return { url: current, title, text: text.slice(0, PER_URL_CHARS) }
  }
  return null /* too many redirects */
}

/**
 * Build the context block for a single user message: find its public URLs, read
 * them, and return a model-facing digest (or '' when there is nothing to read).
 * Never throws — the chat must work even if every link is dead.
 */
export async function buildWebContext(text) {
  if (!config.webFetchEnabled) return ''
  const urls = extractUrls(text).filter(isSafeUrl).slice(0, MAX_URLS)
  if (!urls.length) return ''
  const pages = []
  for (const url of urls) {
    try {
      const page = await readUrl(url)
      if (page) pages.push(page)
    } catch {
      /* one bad link must not sink the others or the reply */
    }
  }
  if (!pages.length) return ''
  let budget = TOTAL_CHARS
  const blocks = []
  for (const p of pages) {
    if (budget <= 0) break
    const clipped = p.text.slice(0, Math.max(0, budget))
    budget -= clipped.length
    blocks.push(`URL: ${p.url}\nTITLE: ${p.title || '(none)'}\nPAGE CONTENT:\n"""\n${clipped}\n"""`)
  }
  if (!blocks.length) return ''
  return `(The user shared these web links. Nexora fetched and read them for you just now — this is the real, current content of those pages, so answer using it instead of saying you cannot open links. Quote or summarise it as asked; if a page seems irrelevant to the question, say so briefly.)\n\n${blocks.join('\n\n')}`
}
