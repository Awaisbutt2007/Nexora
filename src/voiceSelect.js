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
 * a rate that still sits under the server's `TTS_SPEED` for the same language
 * (the browser engine needs more room than gpt-4o-mini-tts to unstack
 * consonant clusters), a slightly lower pitch so "her" sounds grounded not
 * cartoonish, and a minimal phonetic pass so en-IN voices don't read "kyun" as
 * "keween". Same rewrite list as the backend `tts.js` — keep them in sync so
 * the two paths don't drift apart.
 */

import { respellCommonWords, respellKnownNames } from './namePronunciation.js'

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

/* Voice-list warm cache. Chrome and Edge return an empty array from
 * `speechSynthesis.getVoices()` on the very first call and populate it
 * asynchronously, firing `voiceschanged` after roughly 500 ms to 2 s. That
 * means the FIRST utterance of the session either reads no voices (so we
 * fall through to `voices[0]` and lose the gender/accent chain entirely)
 * or the caller has to `await` inside a click handler and the user hears a
 * silent gap before "Ji haan, boliye". We start the poll the moment the
 * module loads (which is on React mount, before the user signs in), keep
 * the resolved list, and every caller reads the cache synchronously. */
let _voicesCache = []
let _voicesWarm = false
function _readVoices() {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis) return []
    return window.speechSynthesis.getVoices() || []
  } catch { return [] }
}
export function warmVoiceList() {
  if (_voicesWarm) return _voicesCache
  const initial = _readVoices()
  if (initial.length) { _voicesCache = initial; _voicesWarm = true; return initial }
  /* Empty on first read: subscribe once, keep the resolution when it fires. */
  try {
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      const list = _readVoices()
      if (list.length) { _voicesCache = list; _voicesWarm = true }
    }, { once: true })
  } catch { /* older engines expose only `onvoiceschanged` */
    try {
      window.speechSynthesis.onvoiceschanged = () => {
        const list = _readVoices()
        if (list.length) { _voicesCache = list; _voicesWarm = true }
      }
    } catch { /* nothing more we can do; the fallback in configureUtter handles it */ }
  }
  return initial
}
/* Called from anywhere that has a `speechSynthesis` reference (Nexora.jsx on
 * mount, VoiceCall.jsx before the first speak). Returns the current best list;
 * if the browser has not finished enumerating yet it hands back whatever we
 * have (an empty array) and the caller falls through to the default engine
 * voice just for the first utterance, and every subsequent call is fast. */
export function getCachedVoices() {
  if (_voicesWarm && _voicesCache.length) return _voicesCache
  const live = _readVoices()
  if (live.length) { _voicesCache = live; _voicesWarm = true }
  return _voicesCache
}

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
  /* An English reply used to start at en-US — an American voice reading "Awais"
     "a-WAYS" and "comfortable" "comfor-table", the exact accent the user asked NOT
     to hear. en-IN is now first everywhere: the same clear Indian-English diction
     the pronunciation tables aim at, on a voice that already has those phonemes.
     en-US stays in the chain as a rescue, because a machine with only an American
     voice installed must still speak. */
  en: ['en-IN', 'en-GB', 'en-US', 'en'],
  ur: ['ur', 'hi', 'en-IN', 'en-GB', 'en'],
  hinglish: ['hi', 'en-IN', 'en-GB', 'en'],
  auto: ['en-IN', 'hi', 'en-GB', 'en'],
}
/* Mixed-script replies still need to breathe, but the user asked for a
 * livelier delivery, so every rate is raised roughly +0.1 from the previous
 * tuning (Hinglish 0.78 → 0.88, Urdu 0.74 → 0.84, auto 0.82 → 0.92) while the
 * relative ordering is preserved: Hinglish and Urdu stay under English because
 * the default engine rushes consonant clusters on those scripts and the
 * phonetic rewrite below adds syllable breaks that need time to land. If
 * Hinglish starts garbling again, drop `hinglish` back toward 0.85 before
 * touching anything else — that value is the one the engine is least able to
 * read quickly. */
const LANG_RATE = { en: 1.15, hinglish: 0.88, ur: 0.84, auto: 0.92 }
export const MIXED_LANGUAGES = new Set(['hinglish', 'auto', 'ur'])
/* Natural locale hint per reply language (the value we set on `utter.lang`
 * before we know which voice we're going to end up with; after picking the
 * voice we sync it to that voice's own tag). */
/* Only the SYNTHESIS side moved to en-IN. The `REC_LOCALES` tables in
 * VoiceCall.jsx / useWakeWord.js deliberately keep en-US for *listening* — that
 * choice is about which engine transcribes a mixed sentence best, not about how the
 * companion sounds, and the en-US recogniser has the widest coverage. */
export const TTS_NATURAL_LOCALE = { en: 'en-IN', ur: 'ur-PK', hinglish: 'hi-IN', auto: 'en-IN' }

/* Kept in lock-step with INDIC_REWRITES in backend/src/services/tts.js — the
 * backend does the same pass before hitting `gpt-4o-mini-tts`, so a user
 * who has an OpenAI key and one who doesn't hear the SAME corrected vowels.
 * A wider list on the browser path is MORE important than on the server
 * path, because en-IN / en-GB Windows voices have zero Indic training data
 * and mangle almost every Latin-script word without the phoneme nudges. */
const INDIC_REWRITES = [
  [/\bkyun(ke|ki)?\b/gi, (_m, tail = '') => `kayun${tail}`],
  [/\bkyon(ke|ki)?\b/gi, (_m, tail = '') => `kayon${tail}`],
  [/\bkyunki\b/gi, 'kayun-kee'],
  [/\bkyonki\b/gi, 'kayon-kee'],
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
  [/\bsamjhi\b/gi, 'sam-jhee'],
  [/\bzaroor\b/gi, 'za-roor'],
  [/\bzarurat\b/gi, 'za-ra-rat'],
  [/\bqismat\b/gi, 'kis-mat'],
  [/\bmuqabla\b/gi, 'mu-qa-bla'],
  [/\braasta\b/gi, 'raa-sta'],
  [/\bwaqt\b/gi, 'vakht'],
  [/\btha\b/gi, 'thaa'],
  [/\bthi\b/gi, 'thee'],
  [/\bthoda\b/gi, 'tho-daa'],
  [/\bthodi\b/gi, 'tho-dee'],
  [/\bthora\b/gi, 'tho-raa'],
  [/\bhoon\b/gi, 'houn'],
  [/\bhuwa\b/gi, 'hoo-aa'],
  [/\bhuwi\b/gi, 'hoo-ee'],
  [/\bkarta\b/gi, 'kar-taa'],
  [/\bkarti\b/gi, 'kar-thee'],
  [/\bkarte\b/gi, 'kar-tay'],
  [/\bleta\b/gi, 'lay-taa'],
  [/\bleti\b/gi, 'lay-thee'],
  [/\blete\b/gi, 'lay-tay'],
  [/\bliya\b/gi, 'lee-yaa'],
  [/\bliye\b/gi, 'lee-yay'],
  [/\bdiya\b/gi, 'dee-yaa'],
  [/\bgaya\b/gi, 'gaa-yaa'],
  [/\bgayi\b/gi, 'gaa-yee'],
  [/\bpyar\b/gi, 'pyaar'],
  [/\bkhana\b/gi, 'khaa-na'],
  [/\bkhaana\b/gi, 'khaa-na'],
  [/\bpani\b/gi, 'paa-nee'],
  [/\bpaani\b/gi, 'paa-nee'],
  [/\bsardi\b/gi, 'sar-dee'],
  [/\bgarmi\b/gi, 'gar-mee'],
  [/\bnazdeek\b/gi, 'naz-deek'],
  [/\bdosti\b/gi, 'dos-tee'],
  [/\bzindagi\b/gi, 'zin-daa-gi'],
  [/\bwaqai\b/gi, 'vaa-qa-ee'],
  [/\bhaqeeqat\b/gi, 'ha-qee-qat'],
  [/\bsocha\b/gi, 'so-chaa'],
  [/\bsochi\b/gi, 'so-chee'],
  [/\bdikha\b/gi, 'dee-khaa'],
  [/\bdikhi\b/gi, 'dee-khee'],
  [/\bmujhe\b/gi, 'muj-heh'],
  [/\btujhe\b/gi, 'tuj-heh'],
  [/\bhoga\b/gi, 'ho-gaa'],
  [/\bhogi\b/gi, 'ho-ghee'],
  [/\bchahiye\b/gi, 'chaa-hee-yay'],
  [/\bchahye\b/gi, 'chaa-hee-yay'],
  [/\bkarlo\b/gi, 'kar-lo'],
  [/\bkarle\b/gi, 'kar-lay'],
  [/\bkarde\b/gi, 'kar-day'],
  [/\bkardega\b/gi, 'kar-day-gaa'],
  [/\bkardegi\b/gi, 'kar-day-ghee'],
  [/\bbatao\b/gi, 'ba-taa-o'],
  [/\bbataye\b/gi, 'ba-taa-yay'],
  [/\bbatana\b/gi, 'ba-taa-na'],
  /* Frequent everyday words the en-IN/en-GB browser voice still flattens: "bhai"
     → "bye", "baat" → "bat", the opener "achha" → "uh-chah". Kept in lock-step
     with the backend list so both engines pronounce them identically. */
  [/\bbhai\b/gi, 'bhaa-ee'],
  [/\bbhaiya\b/gi, 'bhaa-ya'],
  [/\bbaat\b/gi, 'baa-t'],
  [/\bbaatein\b/gi, 'baa-tein'],
  [/\baccha\b/gi, 'aa-chha'],
  [/\bachha\b/gi, 'aa-chha'],
  [/\babhi\b/gi, 'aab-hee'],
  [/\bchalo\b/gi, 'cha-lo'],
  [/\bmasla\b/gi, 'muh-sla'],
  [/\bsubah\b/gi, 'su-bah'],
  [/\bpyaari\b/gi, 'pyaa-ree'],
  [/\bkarunga\b/gi, 'kar-oon-gaa'],
  [/\bkarungi\b/gi, 'kar-oon-ghee'],
  [/\bhoonga\b/gi, 'hoo-oon-gaa'],
  [/\bhoongi\b/gi, 'hoo-oon-ghee'],
]
/* Sentence-auxiliary words the browser engine rushes at rate ≥0.9. When we
 * detect an Indic reply we ALSO shave 6 percent off rate so the extra
 * syllable breaks have time to land. */
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
 * Speaker-facing phonetic pass. Two tables, both mirrored from the backend so the
 * fallback voice and `gpt-4o-mini-tts` say the same word:
 *  - names, corrected in EVERY language (an English reply can address "Awais" too);
 *  - the commonly-mispronounced ENGLISH words, also every language — the one place
 *    the old "never touch English" rule left a real defect in place, because an
 *    en-IN/en-GB letter table reads `comfortable` and `February` exactly as spelled.
 * The Roman-Hindi/Urdu rewrite list then runs on the mixed scripts only, so a plain
 * English reply is still never re-ordered or re-vowelled by a rule meant for Hindi.
 */
export function normalizeForSpeech(text, language) {
  const t = String(text || '')
  if (!t) return ''
  /* Names first, then the English words: the two tables do not overlap, and doing
     both before the Indic pass means a rewrite can never mask a word key. */
  const withNames = respellCommonWords(respellKnownNames(t))
  if (language !== 'hinglish' && language !== 'ur' && language !== 'auto') return withNames
  let out = withNames
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
  /* Prefer the module-level warm cache over whatever the caller passed in —
     a caller that reads `getVoices()` inside a click handler is guaranteed
     to see the empty list on the very first utterance of the session, which
     drops us to `voices[0]` and breaks the chain. Only fall back to the
     caller's list if the cache is still cold AND the caller has one. */
  const cached = getCachedVoices()
  const pool = (cached && cached.length) ? cached : (Array.isArray(voices) ? voices : [])
  const chosen = pickGenderedVoice(pool, { gender, prefers: chain })
  if (chosen) {
    utter.voice = chosen
    /* Match `utter.lang` to the voice's own engine — a mismatched tag makes
       some engines (notably Chrome) run grapheme→phoneme in the wrong table,
       which is what turned Latin Hindi into garble. */
    if (chosen.lang) utter.lang = chosen.lang
  }
  /* Rate profile per language — see LANG_RATE above for the reasoning. The
     1.1 fallback matches `en`, the most likely locale when the caller hands us
     an unknown or missing language key. */
  utter.rate = LANG_RATE[language] ?? 1.1
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
