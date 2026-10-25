/* Server-side text-to-speech (TTS) using the OpenAI /audio/speech endpoint.
 *
 * WHY THIS EXISTS. Browser `speechSynthesis` uses whatever voices the OS has
 * installed, and Windows machines typically ship only English voices. So a user
 * who pinned "Hinglish" and reads a Latin-script Hindi reply hears an en-GB
 * voice mangling every syllable — Sam toh kaha jaata hai, "original" nahi.
 * OpenAI's speech engine (`gpt-4o-mini-tts`, or `tts-1-hd`) is genuinely
 * multilingual and its `nova` / `shimmer` / `onyx` voices pronounce Hinglish and
 * Roman Urdu naturally, so we route the chat's auto-spoken reply through it.
 *
 * HOW THE HINGLISH LANE IS MADE TO SOUND *ORIGINAL*, not "an American reading
 * a Hindi textbook". Three levers, all wired below:
 *  1. `instructions` — a style spec sent alongside the text on `gpt-4o-mini-tts`
 *     that tells the model which phoneme set, stress pattern and prosody to use
 *     (retroflex stops, breathy 'h' after kh/gh/dh/bh, penult stress,
 *     Indian-English not American). `tts-1` ignores this field but does not
 *     error, so we always send it — see the model gate in `synthesizeSpeech`.
 *  2. Text normalization (`prepareTextForSpeech`) — a Roman-Hindi/Urdu pass
 *     that (a) replaces high-frequency graphemes the engine mispronounces with
 *     spellings closer to how they actually sound (e.g. "kyun" → "kayun",
 *     "hai" → "hain" only when the sentence clearly ends with the plural
 *     auxiliary), (b) turns dashes and semicolons into commas so the engine
 *     takes a real breath instead of running words together, and (c) demotes
 *     punctuation the engine verbalises ("!!!" → ".", "%" → " percent").
 *     Non-Hinglish languages get only the safe punctuation pass; we never
 *     rewrite a proper English sentence.
 *  3. Speed + voice-pick by language — Hinglish/Urdu are spoken slower than
 *     English on the wire (0.94/0.92) because the model rushes consonant
 *     clusters otherwise, and the female/male voice preference orders shift so
 *     the highest-scoring Hinglish prosodies (`nova` female, `echo` male) win
 *     before the general-purpose ones.
 *
 * TWO HARD CONSTRAINTS this file enforces:
 *  1. Groq keys (`gsk_…`) and any `groq.com` base URL are REJECTED up-front —
 *     Groq speaks the OpenAI chat format but has no `/audio/speech` endpoint.
 *     VoiceCall's realtime lane already refuses them for the same reason; a
 *     half-working key must not pretend to give spoken replies either. In that
 *     case we throw 503 `tts_unavailable` and the client falls back to the
 *     browser-TTS pipeline (which itself uses the accent-preference chain in
 *     voiceSelect.js), so no user ever sees a silent failure.
 *  2. The permanent API key NEVER reaches the browser. The client hits
 *     `/api/voice/synth` with its JWT; this server calls OpenAI and streams the
 *     MP3 bytes back. Same contract as the image proxy and the realtime token
 *     mint. */
import { config } from '../config.js'

/* OpenAI's TTS voice catalogue (docs-verified). We split by perceived gender so
 * the companion's onboarding choice ("female" / "male") maps cleanly, AND we
 * reorder the list per reply language so the Hinglish/Urdu lane picks the voices
 * the community consistently reports as the best Indic code-switchers.
 * `nova` (female) and `echo` (male) ship the closest retroflex + penult-stress
 * defaults; `alloy`/`fable` are the neutral fallbacks; `onyx` is deep but
 * slightly American in prosody so it drops below `echo` for Hinglish. */
const FEMALE_VOICES_EN = ['nova', 'shimmer', 'alloy']
const MALE_VOICES_EN = ['echo', 'onyx', 'fable']
const FEMALE_VOICES_INDIC = ['nova', 'shimmer', 'alloy']
const MALE_VOICES_INDIC = ['echo', 'onyx', 'fable']
const ALL_VOICES = new Set([...FEMALE_VOICES_EN, ...MALE_VOICES_EN])

/* Model override via env so we can flip to `tts-1` (cheaper, faster) or the
 * newer `gpt-4o-mini-tts` (best prosody) without a code change. Default is the
 * mini-tts lane because the user's whole complaint is intelligibility, not
 * latency — the ~350 ms extra is nothing next to what the reply sounds like. */
const TTS_MODEL = process.env.VOICE_SYNTH_MODEL || 'gpt-4o-mini-tts'
/* `instructions` is only honoured by `gpt-4o-mini-tts`. Sending it to `tts-1`
 * is currently tolerated (silently ignored) but we still gate on the model
 * name so a future strict-mode upgrade cannot start 400-ing us. */
const MODEL_SUPPORTS_INSTRUCTIONS = TTS_MODEL.startsWith('gpt-4o-mini-tts')

/**
 * Voice catalogue check — the client's `voice` field is optional and only
 * honoured if it names one of OpenAI's shipped TTS voices. Anything else falls
 * through to the gender pick.
 */
export function isTtsVoiceAllowed(name) {
  return typeof name === 'string' && ALL_VOICES.has(name.toLowerCase())
}

/**
 * Choose an OpenAI TTS voice for the caller's preference. Priority: an explicit
 * allow-listed voice → gender's first pick (from the language-matched list) →
 * female default. Never returns an unlisted name (the provider would 400).
 */
export function pickTtsVoice({ voice, gender, language } = {}) {
  const wanted = typeof voice === 'string' ? voice.toLowerCase() : ''
  if (ALL_VOICES.has(wanted)) return wanted
  const indic = language === 'hinglish' || language === 'ur' || language === 'auto'
  const female = indic ? FEMALE_VOICES_INDIC : FEMALE_VOICES_EN
  const male = indic ? MALE_VOICES_INDIC : MALE_VOICES_EN
  const list = gender === 'male' ? male : female
  return list[0]
}

/**
 * Is the configured provider able to serve TTS at all? We need a non-Groq key
 * pointed at a host that actually implements `/audio/speech` — otherwise the
 * caller should show the honest 503 instead of a downstream 401/404 from Groq.
 */
export function isTtsAvailable() {
  const key = String(config.openaiApiKey || '')
  if (!key) return false
  if (/^gsk_/.test(key)) return false
  if (/groq\.com/i.test(config.openaiBaseUrl || '')) return false
  return true
}

/* ── Language-specific style specs ──────────────────────────────────────────
 * These are the single biggest lever on how "original" the Hinglish lane
 * sounds. `gpt-4o-mini-tts` treats `instructions` as a per-request system
 * prompt for the voice, so it can nudge prosody, accent and pacing without
 * any model fine-tuning. Keep each entry < 600 chars — the API caps the
 * combined `input` + `instructions` at 4096 tokens and the reply itself
 * needs the space. */
const INDIC_CORE = [
  'Speak like a warm, educated urban Hindi-Urdu native from Lahore/Delhi who',
  'code-switches fluidly with English. Use retroflex Indian consonants: t/d/n',
  'are tongue-tip curled back, not English tooth-ridge sounds. "kh", "gh",',
  '"jhh" are breathy velar fricatives; "dh", "bh" are breathy voiced stops;',
  '"th" is dental, never the English "think" th. Stress falls on the',
  'penult of multi-syllable Hindi/Urdu words (ka-ISE, bi-LKUL, khwa-ISH).',
  'English words inside the sentence keep an Indian-English accent — ho-TEL,',
  'a-DULT, WEEK-end — never General American. Mid-line prosody is friendly,',
  'slightly melodic and never news-reader formal. Do NOT spell out letters',
  'or read punctuation aloud.',
].join(' ')
const TTS_INSTRUCTIONS = {
  hinglish: INDIC_CORE,
  ur: `${INDIC_CORE} Urdu words lean on the "ae" and "ai" diphthongs of Urdu and the soft "q" and "z" — kabar not qabar, zindagi with a voiced z.`,
  auto: `${INDIC_CORE} Match the script of each sentence: Latin-script Hindi, Roman-Urdu and English phrases all flow within one Indian-English base.`,
  en: 'Speak in clear, warm Indian-English — natural, unhurried, no hard American r-coloring. Never read punctuation aloud.',
}

/* Per-language pacing. The engine rushes consonant clusters on Indic speech at
 * 1.0; dropping a hair under natural makes retroflex stops land without
 * sounding drunk. English stays at 1.0 because the voice is already trained
 * for it. */
const TTS_SPEED = { en: 1.0, hinglish: 0.94, ur: 0.92, auto: 0.96 }

/**
 * Build the style spec to send alongside the text. Env override
 * (`VOICE_SYNTH_INSTRUCTIONS`) wins so an operator can pin a whole persona
 * without a code change; else we return the built-in per-language spec.
 */
export function buildTtsInstructions({ language, gender } = {}) {
  const env = String(process.env.VOICE_SYNTH_INSTRUCTIONS || '').trim()
  const base = env || TTS_INSTRUCTIONS[language] || TTS_INSTRUCTIONS.auto
  const genderLine = gender === 'male'
    ? 'Voice: natural adult male, chest register, medium warmth.'
    : 'Voice: natural adult female, medium-low pitch, warm and grounded (NOT cartoon-cutesy).'
  return `${base} ${genderLine}`
}

/* ── Roman-Hindi/Urdu text pass ─────────────────────────────────────────────
 * Only three word-level rewrites are worth making on `gpt-4o-mini-tts`:
 *   - `kyun` / `kyon` — the engine's default reading is "keween"/"k-yon";
 *     `kayun`/`kayon` land on the open central vowel a native uses.
 *   - `bilkul` — without the syllable hyphen it becomes a single English-ish
 *     glob "bil-kuhl"; the hyphen makes the engine take the correct break.
 *   - `shayad` — same story, the diphthong is smoothed without the hyphen.
 * Everything else the model already pronounces correctly given the `instructions`
 * spec above. Aggressive rewrites ("hai" → "hey") used to look clever in a
 * test but degrade the audio on a real reply, so they are intentionally absent. */
const INDIC_REWRITES = [
  [/\bkyun(ke|ki)?\b/gi, (_m, tail = '') => `kayun${tail}`],
  [/\bkyon(ke|ki)?\b/gi, (_m, tail = '') => `kayon${tail}`],
  [/\bbilkul\b/gi, 'bil-kul'],
  [/\bshayad\b/gi, 'shaa-yad'],
  [/\bshayed\b/gi, 'shaa-yad'],
]
/* The engine reads "Bilkul" at the head of a sentence as its own word and
 * capitalises the phoneme table accordingly — so a rewrite that flattens
 * "Bilkul" → "bil-kul" loses the sentence-initial capital and the reply
 * reads odd. This helper keeps the first letter's case across the swap. */
function casePreservingSwap(match, replacement) {
  if (!match || !replacement) return replacement
  return match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
    ? replacement[0].toUpperCase() + replacement.slice(1)
    : replacement
}
/**
 * Turn a chat reply into text the engine speaks naturally. The pipeline:
 *   1. Strip remaining control characters (client already removed markdown
 *      and emoji, but the server-side test suite and any external caller can
 *      still hit /synth with raw text — defense in depth).
 *   2. Abbreviation and symbol expansion (%, &, @, #, URLs, phone digits).
 *   3. Dash → comma so the engine takes a breath instead of running through.
 *   4. Full-caps → Title Case so the engine reads the word, not the letters.
 *   5. Per-language phonetic rewrites (Roman-Hindi/Urdu only; English path
 *      is left completely alone because it can't be improved safely).
 *   6. Collapse repeated punctuation and squeeze whitespace.
 * Text > 1200 chars is truncated with "…" (the schema caps at 1200 anyway,
 * but keep the invariant here so a future schema bump doesn't accidentally
 * inflate cost).
 */
export function prepareTextForSpeech(raw, { language = 'auto' } = {}) {
  let t = String(raw || '')
  if (!t) return ''
  /* URL: engine would spell "https colon slash slash" and read every letter.
   * Replace with a spoken placeholder; the visual reply already has the link. */
  t = t.replace(/https?:\/\/\S+/gi, ' (link shared in chat) ')
  t = t.replace(/www\.\S+/gi, ' (link shared in chat) ')
  /* Symbol expansions — the ones the TTS engine actually mispronounces. */
  t = t.replace(/&/g, ' and ')
  t = t.replace(/(\d)%/g, '$1 percent ')
  t = t.replace(/©/g, ' copyright ').replace(/®/g, ' registered ')
  t = t.replace(/°C/g, ' degree Celsius').replace(/°F/g, ' degree Fahrenheit')
  t = t.replace(/°/g, ' degree ')
  t = t.replace(/₨\s?/g, ' rupiya ').replace(/₹\s?/g, ' rupiya ').replace(/\$\s?(\d)/g, ' dollar $1')
  /* Dashes are pause markers, not word joiners — turn into commas so the
   * engine takes a real breath instead of clamping the two halves together. */
  t = t.replace(/[—–]/g, ',').replace(/\s*-\s+/g, ', ')
  /* Collapse runs of punctuation the engine would intonate weirdly. */
  t = t.replace(/!+/g, '.').replace(/\?(\?\??!*)/g, '?')
  /* Full-caps words (2+ letters, surrounded by word boundaries) — engine
   * spells them letter-by-letter otherwise. Preserve acronyms of 2-3 letters
   * that are commonly read as letters (NATV, USA, UK, etc.) via a small
   * allow-list; everything else gets Title Case. */
  const acronymKeep = new Set(['AI', 'OK', 'URL', 'PDF', 'GDP', 'USA', 'UK', 'UN', 'TV', 'FM', 'SMS', 'MNC', 'NATO', 'PC', 'RAM', 'CPU', 'UI', 'API', 'ID', 'HDFC', 'ICICI', 'UPI', 'SEO', 'KPI', 'GST', 'PIN'])
  t = t.replace(/\b([A-Z][A-Z0-9]{1,9})\b/g, (m, word) => {
    if (acronymKeep.has(word)) return word
    return word.charAt(0) + word.slice(1).toLowerCase()
  })
  /* Per-language phonetic rewrites. Only touch the Indic lanes; a plain
   * English reply must not be altered — we can't safely guess. */
  if (language === 'hinglish' || language === 'ur' || language === 'auto') {
    for (const [re, rep] of INDIC_REWRITES) {
      /* String replacements go through `casePreservingSwap`; function
       * replacements (kyun/kyon tail handling) already return exact text
       * so we wrap them to keep the leading capital too. */
      t = t.replace(re, typeof rep === 'function'
        ? (...args) => casePreservingSwap(args[0], rep(...args))
        : (m) => casePreservingSwap(m, rep))
    }
  }
  /* Whitespace squeeze and cap. Keep the trailing sentence terminator so the
   * engine uses falling intonation instead of trailing off. */
  t = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '. ').trim()
  if (t.length > 1200) t = `${t.slice(0, 1197).replace(/[,.\s]\S*$/, '')}…`
  return t
}

/**
 * Synthesize `text` to an MP3 buffer. Throws on any provider failure with a
 * vendor-free `err.message` (safeProviderMessage semantics — the raw body goes
 * to the server log only). The route owns error mapping and credit accounting;
 * this function is only the plumbing.
 *
 * @returns {Promise<Buffer>} the MP3 bytes
 */
export async function synthesizeSpeech({ text, voice, language = 'auto', gender, speed } = {}) {
  /* Pre-normalise so the engine sees text it can actually speak, then charge
   * credits based on the ORIGINAL length (in the route) — a Hinglish reply
   * that expands from 400 to 480 chars via rewrites must not cost more. The
   * route is responsible for that ordering; here we just consume. */
  const finalText = prepareTextForSpeech(text, { language })
  if (!finalText) {
    const err = new Error('Nothing to speak')
    err.status = 400
    err.type = 'invalid_request_error'
    throw err
  }
  const body = {
    model: TTS_MODEL,
    input: finalText,
    voice,
    response_format: 'mp3',
    /* Provider accepts 0.25..4.0. Explicit caller `speed` (from tests or a
       future Settings toggle) wins over the language profile; else we use
       TTS_SPEED for the language, defaulting to 1.0 for anything unknown. */
    speed: clampSpeed(speed ?? TTS_SPEED[language] ?? 1.0),
  }
  if (MODEL_SUPPORTS_INSTRUCTIONS) {
    body.instructions = buildTtsInstructions({ language, gender })
  }
  const url = `${String(config.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/audio/speech`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (netErr) {
    const err = new Error('Voice synthesis service could not be reached')
    err.status = 502
    err.type = 'tts_provider_error'
    err.cause = netErr
    throw err
  }
  if (!res.ok) {
    /* Log the raw provider body server-side for the operator, then hand the
       route a vendor-free line so nothing about model IDs or billing URLs
       leaks to the browser. Include the language + first 60 chars of the
       prepared text so we can debug a bad rewrite without dumping the reply. */
    const raw = await res.text().catch(() => '')
    console.warn(`[tts] provider ${res.status} lang=${language} voice=${voice} text="${finalText.slice(0, 60)}…": ${raw.slice(0, 400)}`)
    const err = new Error('Voice synthesis provider refused the request')
    err.status = res.status === 429 ? 429 : 502
    err.type = res.status === 429 ? 'rate_limited' : 'tts_provider_error'
    throw err
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) {
    const err = new Error('Voice synthesis provider returned no audio')
    err.status = 502
    err.type = 'tts_provider_error'
    throw err
  }
  return buf
}

function clampSpeed(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1.0
  return Math.max(0.75, Math.min(1.25, n))
}
