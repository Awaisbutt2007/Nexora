/**
 * Name pronunciation table for the BROWSER speech path.
 *
 * Why this exists: the browser's SpeechSynthesis has NO `instructions` parameter,
 * so the only lever is changing the word itself before the grapheme→phoneme
 * (GPM) table sees it. The SERVER path (backend/src/services/tts.js) does the
 * same text-level respelling AND adds an explicit pronunciation hint in the
 * instructions prompt — belt and suspenders for the neural model.
 *
 * The "Awais" family below is kept in this table for the browser GPM table
 * even though the server path now handles them via instructions.
 *
 * Two rules for the respellings:
 *  - NO hyphens. A hyphen is a breath marker in the browser engine, so a
 *    hyphenated name is read as two dragged halves — exactly the "latkaa hua"
 *    complaint.
 *  - Spell what the English table should emit, not what the name "looks"
 *    like. Verified against pronunciation audio (HowToSay IPA /æwæɪs/,
 *    PronounceNames "a · wai · s", the "Awais: Pronunciation and Meaning"
 *    video): short "a" + W + "ice", stress on the second syllable.
 *    "aavais" lost the w ("AA-vais") and "uwais" forced a "yoo/oo" onset;
 *    "ahwice" hits the exact sounds on an English table.
 */
export const NAME_RESPPELLINGS = {
  awais: 'ahwice',
  awaiz: 'ahwice',
  awaiss: 'ahwice',
  uwaiss: 'ahwice',
  uwais: 'ahwice', /* plain-ASCII variant spellings fold into the same token */
  owais: 'ahwice',
  aira: 'aaira', /* one clean token — the engine reads a single 'a' as schwa */
}

/**
 * Commonly mispronounced ENGLISH words, mirrored from `WORD_SPEAK` in
 * `backend/src/services/pronunciation.js` (the backend suite asserts the two tables
 * stay in step, because a drift would mean the fallback voice says a word the server
 * voice never would).
 *
 * Why this list exists at all: the phonetic pass used to cover Roman Urdu/Hinglish
 * only, on the reasoning that rewriting English was unsafe guesswork. That left the
 * single most common complaint untouched — an English letter-table reads
 * `comfortable` as "com-for-table" and `February` as "Feb-ru-ary", which is exactly
 * what the pronunciation teachers our users learn from correct on camera. So the list
 * is deliberately narrow: only words with one unambiguous dictionary pronunciation,
 * never contested ones (GIF, either, zebra), and only a respelling an English
 * grapheme table provably reads right.
 */
export const WORD_RESPPELLINGS = {
  comfortable: 'kumf-ter-bul',
  vegetables: 'vet-er-bels',
  vegetable: 'vet-er-bel',
  temperature: 'tem-per-eh-cher',
  february: 'feb-yoo-air-ee',
  wednesday: 'wenz-day',
  breakfast: 'brek-fust',
  coffee: 'kaw-fee',
  chocolate: 'chok-lat',
  question: 'kwes-chun',
  picture: 'pik-cher',
  nature: 'nay-cher',
  future: 'fyoo-cher',
  structure: 'struk-cher',
  natural: 'nach-er-al',
  beautiful: 'byoo-ti-ful',
  pronunciation: 'pro-nun-see-a-shun',
  dictionary: 'dik-shun-er-ee',
  schedule: 'sked-jool',
  situation: 'sich-oo-a-shun',
  improve: 'im-proov',
  opposite: 'op-oz-it',
  disaster: 'di-zas-ter',
  enough: 'i-nuhf',
  govern: 'guv-ern',
  great: 'grayt',
  scholar: 'skaw-ler',
  aquarium: 'a-kwair-ee-um',
  disease: 'diz-eez',
  advance: 'ad-vans',
  apparatus: 'ap-a-ras',
}

/* Longest key first, so `vegetables` can never be half-eaten by `vegetable`. */
const sortedWords = Object.keys(WORD_RESPPELLINGS).sort((a, b) => b.length - a.length)
const wordRe = new RegExp(`\\b(${sortedWords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')

/* Longest-first so a longer name wins when one is a prefix of another, and
 * the regex source is built once per table instead of per spoken sentence. */
const sortedEntries = Object.entries(NAME_RESPPELLINGS).sort((a, b) => b[0].length - a[0].length)
const nameRe = new RegExp(`\\b(${sortedEntries.map(([k]) => k).join('|')})\\b`, 'gi')

/**
 * Replace every known name in `text` with its engine-friendly respelling,
 * keeping the original leading capital (the same `casePreservingSwap`
 * discipline the phonetic word-lists follow).
 */
export function respellKnownNames(text) {
  const t = String(text || '')
  if (!t) return ''
  nameRe.lastIndex = 0
  if (!nameRe.test(t)) return t
  nameRe.lastIndex = 0
  return t.replace(nameRe, (m) => {
    const out = NAME_RESPPELLINGS[m.toLowerCase()]
    if (!out) return m
    return m[0] === m[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out
  })
}

/**
 * The English-word pass. Idempotent by construction: no respelling contains one of
 * these keys as a whole word ("vet-er-bel" is not `vegetable`), so re-running it on
 * text the server already normalised cannot compound. The leading capital is kept
 * because the engines read a sentence-initial capital as a prosody marker — and this
 * pass only ever touches the utterance, never the message shown on screen.
 */
export function respellCommonWords(text) {
  const t = String(text || '')
  if (!t) return ''
  wordRe.lastIndex = 0
  if (!wordRe.test(t)) return t
  wordRe.lastIndex = 0
  return t.replace(wordRe, (m) => {
    const out = WORD_RESPPELLINGS[m.toLowerCase()]
    if (!out) return m
    return m[0] === m[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out
  })
}
