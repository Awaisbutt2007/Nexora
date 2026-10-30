/* ── The single source of truth for how Nexora SPEAKS a word ────────────────
 *
 * WHY THIS FILE EXISTS. The pronunciation data used to live inside `tts.js`, so the
 * chat's auto-spoken reply (server TTS) and the browser fallback knew how to say
 * "Awais", but the **realtime Talk surface did not** — speech-to-speech gets no text
 * pass at all, only the `instructions` we send when the session is created. The
 * provider therefore guessed, and a user whose name is spelled `Awais` heard
 * "awiys"/"a-ways" (a Z where an English speaker expects the "nice" S). Same story
 * for ordinary English words: the tables only ever covered Roman Urdu/Hinglish, so
 * `comfortable` / `vegetable` / `February` were read exactly the way the letters
 * look — which is what the English-teaching channels our users learn from
 * (English Connection by Kanchan, English Coach Chad) spend whole videos correcting.
 *
 * So the data lives here once and every surface reads it in the one form that
 * surface can actually obey:
 *  - `respellKnownNames` / `respellWords` → for grapheme→phoneme engines (the browser
 *    `speechSynthesis` fallback). Those rewrite the letters, because such engines have
 *    no way to be told anything.
 *  - `speechHintsText` / `staticSpeechHints` / `nameHintsFor` → for the neural voices
 *    (server `gpt-4o-mini-tts` and realtime Talk), which follow `instructions` well and
 *    over-articulate a hyphenated respelling. They get told, not re-spelled.
 *
 * The accent these rules aim at is the one users asked for: **clear neutral
 * Indian-English**, syllable by syllable, the way Kanchan Keshari pronounces a word
 * on camera — every consonant audible, stress on the syllable the dictionary puts it
 * on, no American flapping or reduction. That is a *diction* target, not an
 * impression of a real person: we never clone or mimic a named speaker's voice, and
 * nothing here claims to be one.
 *
 * TWO RULES FOR THE TABLES
 *  1. `respell` is what an ENGLISH letter-table must read, not what the word looks
 *     like. Capital letters mark the stressed syllable (the browser engines give a
 *     capitalised chunk more weight), hyphens mark syllable breaks — the same
 *     breath-marker convention `tts.js` already relies on for Indic words.
 *  2. Only words we are sure about. A wrong respelling is worse than no respelling,
 *     and the browser pass rewrites text the user can also *see* in the transcript.
 *    contestable / GIF / "either" style debates stay out on purpose.
 */

/* Names, with BOTH levers filled in, because the two engine classes need different
 * ones:
 *  - `respell` — what the browser's `speechSynthesis` (no instruction lever at all)
 *    must be handed. Verified value: "ahwice" hits short-a + W + "ice" on an English
 *    letter table.
 *  - `instructionOnly` — the NEURAL paths (server `gpt-4o-mini-tts`, realtime) must
 *    see the name in its real spelling and be TOLD how to say it. Handing them
 *    "Ahwice" made it sound like broken Roman English, which is why the flag exists.
 *  - `hint` — the line those neural voices get. The user confirmed this target: short
 *    "uh" + "WICE" (rhymes with NICE, unvoiced S, never a Z). */
export const NAME_SPEAK = {
  awais: { respell: 'ahwice', instructionOnly: true, hint: 'When you say the name "Awais", pronounce it EXACTLY as "uh-WICE" — start with a soft short "uh" (the sound at the start of "about" or "alone"), then "WICE", which rhymes with "NICE" and ends with a crisp unvoiced S, NOT a Z and NOT like "wise". Stress on "WICE", glued together as one smooth two-syllable word. NEVER "AA-waais", NEVER "AY-waze", NEVER "ah-WAACE".' },
  awaiz: { respell: 'ahwice', instructionOnly: true, hint: 'Say the name "Awaiz" as uh-WICE, same as Awais, crisp unvoiced S.' },
  awaiss: { respell: 'ahwice', instructionOnly: true, hint: 'Say the name "Awaiss" as uh-WICE, crisp unvoiced S.' },
  uwaiss: { respell: 'ahwice', instructionOnly: true, hint: 'Say the name "Uwaiss" as uh-WICE, crisp unvoiced S.' },
  uwais: { respell: 'ahwice', instructionOnly: true, hint: 'Say the name "Uwais" as uh-WICE, crisp unvoiced S.' },
  owais: { respell: 'ahwice', instructionOnly: true, hint: 'Say the name "Owais" as uh-WICE, crisp unvoiced S.' },
  aira: { respell: 'aaira', instructionOnly: false, hint: 'Say the name "Aira" as AY-ra, two syllables, stress on the first.' },
}

/* Commonly mispronounced English words — the class these teaching channels cover.
 * `respell` is for letter-table engines and is ALWAYS lowercase and hyphenated: a
 * hyphen is a documented syllable break in this repo's own engines, while spelling a
 * chunk in capitals is an undocumented guess those engines may read as an acronym.
 * `say` is the human-readable anchor for the neural voices, and that is where the
 * capitalised stress really belongs — a model following `instructions` reads it as
 * "stress this syllable", a grapheme table would just read it louder. */
export const WORD_SPEAK = {
  comfortable: { respell: 'kumf-ter-bul', say: 'KUMF-ter-bul' },          // never "com-for-table"
  vegetables: { respell: 'vet-er-bels', say: 'VET-er-belz' },
  vegetable: { respell: 'vet-er-bel', say: 'VET-er-bel' },                // no "ee" in the first syllable
  temperature: { respell: 'tem-per-eh-cher', say: 'TEM-per-eh-chur' },    // middle "per" stays short
  february: { respell: 'feb-yoo-air-ee', say: 'FEB-yoo-air-ee' },         // the first "ru" is dropped
  wednesday: { respell: 'wenz-day', say: 'WENZ-day' },                    // silent "d"
  breakfast: { respell: 'brek-fust', say: 'BREK-fust' },                  // not "break" + "fast"
  coffee: { respell: 'kaw-fee', say: 'KAW-fee' },                         // not "ko-off-ee"
  chocolate: { respell: 'chok-lat', say: 'CHOK-lat' },                    // three syllables, not four
  question: { respell: 'kwes-chun', say: 'KWES-chun' },                   // "kwest", and "-chun"
  picture: { respell: 'pik-cher', say: 'PIK-cher' },                      // "-ture" = "cher", never "toora"
  nature: { respell: 'nay-cher', say: 'NAY-cher' },
  future: { respell: 'fyoo-cher', say: 'FYOO-cher' },
  structure: { respell: 'struk-cher', say: 'STRUK-cher' },
  natural: { respell: 'nach-er-al', say: 'NACH-er-al' },                  // "-tural" reduces
  beautiful: { respell: 'byoo-ti-ful', say: 'BYOO-ti-ful' },
  pronunciation: { respell: 'pro-nun-see-a-shun', say: 'pro-NUN-see-a-shun' }, // not "pronoun-"
  dictionary: { respell: 'dik-shun-er-ee', say: 'DIK-shun-er-ee' },
  schedule: { respell: 'sked-jool', say: 'SKED-jool' },                    // "sk", not "sh"
  situation: { respell: 'sich-oo-a-shun', say: 'sich-oo-A-shun' },
  improve: { respell: 'im-proov', say: 'im-PROOV' },                       // ends in V, not B
  opposite: { respell: 'op-oz-it', say: 'OP-uh-zit' },                     // the middle O carries the stress
  disaster: { respell: 'di-zas-ter', say: 'di-ZAS-ter' },                  // short "a", not "ah"
  enough: { respell: 'i-nuhf', say: 'i-NUHF' },                            // "-ough" = "uf"
  govern: { respell: 'guv-ern', say: 'GUV-ern' },                          // short "u"
  great: { respell: 'grayt', say: 'GRAYT' },                               // "ay", not "ee"
  scholar: { respell: 'skaw-ler', say: 'SKAW-ler' },                       // "sk", not "sh"
  aquarium: { respell: 'a-kwair-ee-um', say: 'a-KWAIR-ee-um' },            // the "qu" is a K+W
  disease: { respell: 'diz-eez', say: 'diz-EEZ' },                         // "di", not "dis"
  advance: { respell: 'ad-vans', say: 'ad-VANS' },                         // "ad", not "ed"
  apparatus: { respell: 'ap-a-ras', say: 'ap-a-RAS' },                     // "ap", not "epp"
}

/* The diction rule every spoken surface must carry. Kept as one function so the
 * server TTS spec, the realtime `instructions` and the tests can never disagree
 * about what "clear" means. */
export function pronunciationStyleRule() {
  return 'Pronounce every English word the way a clear Indian-English dictionary teacher would: every consonant audible, stress on the syllable the dictionary puts it on, no American flapping, swallowing or reduction, and never spell out a word that should be said as one word.'
}

/* The words the voice gets wrong most often, named up front whether or not this
 * turn contains them — a neural voice that has read the anchor once will apply it
 * to the whole session. Cap keeps the block small enough to be obeyed. */
const CLASSIC_WORDS = ['comfortable', 'vegetable', 'temperature', 'february', 'wednesday', 'question', 'picture', 'pronunciation', 'schedule', 'improve']
export function classicsLine() {
  return `Common English words keep their dictionary sound, never the spelling sound: ${CLASSIC_WORDS.map((w) => `"${w}" = ${WORD_SPEAK[w].say}`).join('; ')}.`
}

/**
 * The never-dynamic half of the block: accent + diction + the classics.
 * A realtime session's `instructions` are set once when the call opens, so this is
 * what that surface can carry before any turn exists.
 */
export function staticSpeechHints() {
  return [pronunciationStyleRule(), classicsLine()].join('\n')
}

/**
 * One explicit line per name the voice is likely to say — from the account's own
 * name and the companion's name — so a renamed assistant or a `Awais`-spelled user
 * is pronounced correctly without a deploy.
 */
export function nameHintsFor(names = []) {
  const list = Array.isArray(names) ? names : [names]
  const keys = [...new Set(list.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean))]
    .map((n) => Object.keys(NAME_SPEAK).find((key) => n.startsWith(key)))
    .filter(Boolean)
  return [...new Set(keys)].slice(0, 4).map((k) => NAME_SPEAK[k].hint)
}

/* Compact per-word lines for the neural voices: only the entries that actually
 * appear in this turn are named, so the prompt does not bloat every message. */
const WORD_HINT_CAP = 10

/** Which WORD_SPEAK keys appear in `text` — word-boundary match, case-insensitive. */
export function speakingWordMatches(text) {
  const t = String(text || '')
  if (!t) return []
  return Object.keys(WORD_SPEAK).filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t))
}

/** Which NAME_SPEAK keys appear in `text`. */
export function speakingNameMatches(text) {
  const t = String(text || '')
  if (!t) return []
  return Object.keys(NAME_SPEAK).filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t))
}

/**
 * Full instruction block for the server TTS `instructions` field, which IS sent
 * per request and therefore can be tailored to the text being spoken.
 * Scan against the RAW text: `prepareTextForSpeech` rewrites spellings first, and a
 * key like "kyun" would no longer be findable in "kayun".
 */
export function speechHintsText(text = '', names = []) {
  const lines = [pronunciationStyleRule(), classicsLine()]
  lines.push(...nameHintsFor([...(Array.isArray(names) ? names : []), ...speakingNameMatches(text)]))
  for (const k of speakingNameMatches(text).slice(0, 2)) {
    const hint = NAME_SPEAK[k].hint
    if (!lines.includes(hint)) lines.push(hint)
  }
  const words = speakingWordMatches(text).filter((w) => !CLASSIC_WORDS.includes(w))
  if (words.length) {
    lines.push(`Pronounce these exactly: ${words.slice(0, WORD_HINT_CAP).map((w) => `"${w}" = ${WORD_SPEAK[w].say}`).join('; ')}.`)
  }
  return lines.join('\n')
}

/** Names whose text form must stay exactly as spelled for a neural voice. */
export const INSTRUCTION_ONLY_NAMES = new Set(
  Object.entries(NAME_SPEAK).filter(([, v]) => v.instructionOnly).map(([k]) => k),
)
/** Every name key, so a caller can tell "known name" from "unknown word". */
export const KNOWN_NAMES = new Set(Object.keys(NAME_SPEAK))
/** GPM form per name — the browser table, kept in one place with the hints. */
export const NAME_RESPELLINGS = Object.fromEntries(
  Object.entries(NAME_SPEAK).map(([k, v]) => [k, v.respell]),
)
/* Longest-first so a longer name wins when one is a prefix of another. */
const NAME_RE = new RegExp(`\\b(${Object.keys(NAME_SPEAK).sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi')

/**
 * Replace every known name in `text` with its engine-friendly respelling, keeping
 * the leading capital. Used by the browser fallback, which has no instruction lever;
 * the neural paths call `nameHintsFor` instead and leave the spelling alone.
 * `keepInstructionOnly: true` is for the server TTS text pass: those voices are
 * better told than re-spelled, so an instruction-only name survives untouched.
 */
export function respellKnownNames(text, { keepInstructionOnly = false } = {}) {
  const t = String(text || '')
  if (!t) return ''
  NAME_RE.lastIndex = 0
  if (!NAME_RE.test(t)) return t
  NAME_RE.lastIndex = 0
  return t.replace(NAME_RE, (m) => {
    const key = m.toLowerCase()
    if (keepInstructionOnly && INSTRUCTION_ONLY_NAMES.has(key)) return m
    const out = NAME_RESPELLINGS[key]
    if (!out) return m
    return m[0] === m[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out
  })
}

/**
 * Text-level pass for grapheme→phoneme engines (server TTS input, browser
 * speechSynthesis). Case-preserving on the leading letter so a sentence-initial
 * word keeps its capital — the engines use it as a sentence-start prosody marker.
 * Idempotent: every respelling is written so none of these patterns can match it
 * again ("kumf-ter-bul" contains no key, "vet-er-bel" is not a key, etc.).
 */
export function respellWords(text) {
  let t = String(text || '')
  if (!t) return ''
  for (const [word, { respell }] of Object.entries(WORD_SPEAK)) {
    if (!respell) continue
    const re = new RegExp(`\\b${word}\\b`, 'gi')
    t = t.replace(re, (m) => (m[0] === m[0].toUpperCase() ? respell[0].toUpperCase() + respell.slice(1) : respell))
  }
  return t
}
