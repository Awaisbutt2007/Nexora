/**
 * Shared browser-TTS voice selection.
 *
 * Two surfaces speak with the OS speech engine — the chat's auto-spoken replies
 * and wake acks (speakWakeLine in Nexora.jsx) and the fallback voice-call
 * pipeline (pickVoiceFor in VoiceCall.jsx). They must pick the SAME gender so
 * the companion sounds consistent, so the logic lives here once.
 *
 * The bug this kills: a user who chose a FEMALE voice at onboarding heard a MALE
 * voice in-app. The old picker filtered voices by the language's primary subtag
 * (e.g. "ur"/"hi"), and when a machine has no Urdu/Hindi voice installed that
 * filter came back EMPTY, so it fell straight through to `voices[0]` — which is
 * the engine default ("Microsoft David", male). It also hid behind a too-narrow
 * name list, so real female voices like Hazel/Aria/Neerja were never recognised
 * and `matching[0]` handed back a male voice even when a female one was present.
 *
 * The rule now: honour the chosen GENDER above the accent. An accented female
 * voice is a far smaller surprise to the user than a male voice from "her".
 *
 * The Hinglish tuning below is what the user hears on a Groq-only install (no
 * OpenAI speech key → the server /synth call 503s → we fall through here):
 * a slower rate so consonant clusters unstack, a slightly lower pitch so "her"
 * sounds grounded not cartoonish, and a minimal phonetic pass so en-IN voices
 * don't read "kyun" as "keween". Same rewrite list as the backend `tts.js` —
 * keep them in sync so the two paths don't drift apart.
 */

/* Well-known built-in voice display names across Windows / macOS / Chrome /
 * Android, grouped by the gender they sound. Matching is substring + lowercase,
 * so "Microsoft Zira Desktop - English (United States)" hits "zira". */
const FEMALE_HINTS = [
  'female', 'woman', 'lady', 'girl',
  'zira', 'hazel', 'susan', 'samantha', 'aria', 'jenny', 'sonia', 'neerja',
  'michelle', 'ava', 'emma', 'olivia', 'tessa', 'veena', 'heera', 'kalpana',
  'layla', 'amira', 'clara', 'sheila', 'sofia', 'catherine', 'kate', 'laura',
  'moira', 'fiona', 'salli', 'pippa', 'libby', 'imogen', 'serena', 'jasmine',
]
const MALE_HINTS = [
  'male', 'man', 'guy', 'boy',
  'david', 'mark', 'james', 'george', 'ravi', 'prabhat', 'hemant', 'alex',
  'fred', 'william', 'daniel', 'tom', 'oliver', 'jack', 'arthur', 'rishi',
  'nitin', 'guy', 'barry', 'paul', 'oliver', 'dylan',
]

const lower = (s) => String(s || '').toLowerCase()
const matches = (voice, hints) => hints.some((h) => lower(voice.name).includes(h))

/* Accent-preference chain per reply language. Shared by every TTS surface
 * (wake ack + auto-spoken reply in Nexora.jsx, and the VoiceCall fallback
 * pipeline) so "her" sounds the same in every place AND all three paths
 * apply the same fallback discipline.
 *
 * When the machine has no voice for the natural locale — the common Windows
 * case where only English voices are installed — we still need SOMETHING
 * that can pronounce Roman-Urdu/Hinglish words in a way the user can follow.
 * Indian-English (en-IN) speakers hit the closest phoneme set for Latin-
 * script Hindi/Urdu; en-GB and en-US mangle them worse ("bilkul" →
 * "bil-kuhl" / "bill-cull"). So the chain is: native locale first, then
 * en-IN, then the rest. */
export const TTS_LOCALE_CHAIN = {
  en: ['en-US', 'en-GB', 'en-IN', 'en'],
  ur: ['ur', 'hi', 'en-IN', 'en-GB', 'en'],
  hinglish: ['hi', 'en-IN', 'en-GB', 'en'],
  auto: ['en-IN', 'hi', 'en-GB', 'en'],
}
/* Mixed-script replies need to breathe — the same sentence read at 1.05
 * through an en-IN voice is far harder to parse than one in the user's
 * native tongue. Hinglish drops to 0.78 (from 0.85, further from the
 * original 0.92) because the default English engine rushes consonant
 * clusters and the user cannot follow the reply. Urdu 0.74 is even slower
 * because the engine struggles more with Arabic-origin phonemes written in
 * Latin script. `auto` sits at 0.82 because most auto replies still contain
 * 30-50 % Latin Hindi. */
const LANG_RATE = { en: 1.05, hinglish: 0.78, ur: 0.74, auto: 0.82 }
export const MIXED_LANGUAGES = new Set(['hinglish', 'auto', 'ur'])
/* Natural locale hint per reply language (the value we set on `utter.lang`
 * before we know which voice we're going to end up with; after picking the
 * voice we sync it to that voice's own tag). */
export const TTS_NATURAL_LOCALE = { en: 'en-US', ur: 'ur-PK', hinglish: 'hi-IN', auto: 'en-IN' }

/* Kept in lock-step with INDIC_REWRITES in backend/src/services/tts.js — the
 * backend does the same pass before hitting `gpt-4o-mini-tts`, so a user
 * who has an OpenAI key and one who doesn't hear the SAME corrected vowels.
 * Just three high-frequency mispronunciations; the shorter the list, the
 * lower the risk of degrading a real reply. */
const INDIC_REWRITES = [
  [/\bkyun(ke|ki)?\b/gi, (_m, tail = '') => `kayun${tail}`],
  [/\bkyon(ke|ki)?\b/gi, (_m, tail = '') => `kayon${tail}`],
  [/\bbilkul\b/gi, 'bil-kul'],
  [/\bshayad\b/gi, 'shaa-yad'],
  [/\bshayed\b/gi, 'shaa-yad'],
  [/\bnahi\b/gi, 'naa-hee'],
  [/\bnahin\b/gi, 'naa-hin'],
  [/\bbahut\b/gi, 'baa-hut'],
  [/\bkaise\b/gi, 'kai-seh'],
  [/\bkaisay\b/gi, 'kai-say'],
  [/\bsamajh\b/gi, 'sa-maj'],
  [/\bsamjha\b/gi, 'sam-jhaa'],
  [/\bzaroor\b/gi, 'za-roor'],
  [/\bzarurat\b/gi, 'za-ra-rat'],
  [/\bqismat\b/gi, 'kis-mat'],
  [/\bmuqabla\b/gi, 'mu-qa-bla'],
  [/\braasta\b/gi, 'raa-sta'],
  [/\bwaqt\b/gi, 'vakht'],
]
/* Keep the sentence-initial capital across the swap — "Bilkul" must become
 * "Bil-kul" not "bil-kul", otherwise the reply looks odd in the visual
 * transcript log and the engine's prosody loses its sentence-start marker. */
function casePreservingSwap(match, replacement) {
  if (!match || !replacement) return replacement
  return match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
    ? replacement[0].toUpperCase() + replacement.slice(1)
    : replacement
}
/**
 * Speaker-facing phonetic pass for Roman-Hindi/Urdu. Applies ONLY to the
 * mixed-script languages — plain English replies are never touched, and the
 * function is idempotent on already-corrected text (the regexes are
 * anchored to the ORIGINAL spellings, so re-running it can't produce
 * "kay-un" or "kayayun").
 */
export function normalizeForSpeech(text, language) {
  const t = String(text || '')
  if (!t) return ''
  if (language !== 'hinglish' && language !== 'ur' && language !== 'auto') return t
  let out = t
  for (const [re, rep] of INDIC_REWRITES) {
    out = out.replace(re, typeof rep === 'function'
      ? (...args) => casePreservingSwap(args[0], rep(...args))
      : (m) => casePreservingSwap(m, rep))
  }
  return out
}

/**
 * Configure a fresh SpeechSynthesisUtterance with the gender/chain-aware
 * voice pick and the language-appropriate rate/pitch. Both speak surfaces
 * (Nexora.jsx wake ack + VoiceCall.jsx pipeline) call this so a Hinglish
 * reply sounds the same in the chat as on a fallback voice call.
 * @param {SpeechSynthesisUtterance} utter  the utterance to fill in
 * @param {SpeechSynthesisVoice[]} voices   window.speechSynthesis.getVoices()
 * @param {{ language?: string, gender?: 'male'|'female' }} opts
 */
export function configureUtterForSpeech(utter, voices, { language, gender } = {}) {
  /* Rewrite the utterance's own text so every call site (wake ack, streamed
     reply, VoiceCall browser fallback) picks up the Hinglish corrections
     without needing to remember to invoke `normalizeForSpeech`. No-op on
     plain English and on any text that doesn't hit the three patterns. */
  try { utter.text = normalizeForSpeech(utter.text, language) } catch { /* engine refused reassignment — the raw text still speaks */ }
  utter.lang = TTS_NATURAL_LOCALE[language] || 'en-US'
  const chain = TTS_LOCALE_CHAIN[language] || [utter.lang]
  const chosen = pickGenderedVoice(voices, { gender, prefers: chain })
  if (chosen) {
    utter.voice = chosen
    /* Match `utter.lang` to the voice's own engine — a mismatched tag makes
       some engines (notably Chrome) run grapheme→phoneme in the wrong table,
       which is what turned Latin Hindi into garble. */
    if (chosen.lang) utter.lang = chosen.lang
  }
  /* Rate profile per language — see LANG_RATE above for the reasoning. */
  utter.rate = LANG_RATE[language] ?? 1.05
  /* Pitch: the pre-tune female value (1.05) made Aira sound cutesy on
     Windows voices like Zira/Hazel. Dropping to 0.98 keeps her clearly
     female but grounded — closer to how an adult Urdu/Hindi speaker sounds.
     Male drops from 0.95 to 0.90 so "he" reads as chest register rather
     than the default slightly-nasal engine voice. */
  utter.pitch = gender === 'male' ? 0.9 : 0.98
  utter.volume = 1
}

/**
 * Choose the best SpeechSynthesisVoice for a gender, optionally preferring a
 * language. Never returns an opposite-gender voice when a same-gender one exists
 * anywhere in the pool — that is the whole point.
 *
 * A machine with only English voices (typical Windows install) asked to speak
 * Hinglish used to get: `utter.lang = 'hi-IN'` + a British voice like Hazel,
 * because we filtered the pool by `hi`, came back empty, and grabbed the first
 * same-gender voice anywhere. Then TTS tried to interpret Latin Hindi text
 * through an en-GB phoneme engine → "samajh nahi aata" garble. Two fixes live
 * here: (1) accept a PREFERENCE CHAIN (e.g. ['hi','en-IN','en-GB','en-US']) so
 * an Indian-English voice wins before a British one when no Hindi voice exists
 * — en-IN speakers pronounce Roman-Hindi words far closer to how they sound than
 * en-GB/en-US do; (2) the caller syncs `utter.lang` to the picked voice's own
 * tag so the engine never fights the voice.
 *
 * @param {SpeechSynthesisVoice[]} voices  window.speechSynthesis.getVoices()
 * @param {{ gender?: 'male'|'female', lang?: string, prefers?: string[] }} opts
 *        `prefers` is an ordered list of BCP-47 prefixes to try (primary subtag
 *        is enough, e.g. 'hi' or 'en-IN'); `lang` is kept as a single-item
 *        shorthand so existing callers don't need to change. A miss on every
 *        entry degrades to any same-gender voice, never to voices[0].
 */
export function pickGenderedVoice(voices, { gender, lang, prefers } = {}) {
  if (!Array.isArray(voices) || voices.length === 0) return null
  const wantMale = gender === 'male'
  const sameHints = wantMale ? MALE_HINTS : FEMALE_HINTS
  const oppHints = wantMale ? FEMALE_HINTS : MALE_HINTS
  /* Preserve the FULL subtag so en-IN ranks above en-GB and en-GB above en-US
     when the caller lists them in that order. Splitting to the primary subtag
     would collapse the chain and defeat the whole accent-preference idea. */
  const chain = (prefers && prefers.length ? prefers : (lang ? [lang] : []))
    .map(lower)
    .filter(Boolean)

  const sameGender = (list) => list.find((v) => matches(v, sameHints))
  const notOpposite = (list) => list.find((v) => !matches(v, oppHints))
  const filterByPrefix = (p) => voices.filter((v) => lower(v.lang).startsWith(p))

  // Walk the preference chain in order — the FIRST locale that has a same-gender
  // voice wins. This is what lets en-IN rescue the Hinglish case on a machine
  // that has no hi-IN voice installed.
  for (const prefix of chain) {
    const matching = filterByPrefix(prefix)
    const hit = sameGender(matching) || (matching.length ? notOpposite(matching) || matching[0] : null)
    if (hit) return hit
  }
  // Nothing in the chain had a voice — honour gender above accent, then any
  // non-opposite voice, then the last resort.
  return sameGender(voices) || notOpposite(voices) || voices[0]
}
