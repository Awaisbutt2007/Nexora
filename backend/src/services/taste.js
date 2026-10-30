/* The companion's OWN tastes — so "tumhe kya pasand hai?" never again gets
 * "main AI hoon, mujhe kuch pasand nahi".
 *
 * WHY THIS EXISTS. The prompt introduced her as "a personal AI assistant" and the
 * spoken sheet told her to "never claim personal experiences you have not had". A
 * model hearing both concludes a preference is a claim it must not make, so it
 * deflected — "Main toh AI hoon, isliye music sunne ka maza nahi aata mujhe!" — and
 * every follow-up about fruit, colour or food hit the same wall. A companion with no
 * tastes reads as a tool, not a company, which is the whole product.
 *
 * WHY IT IS COMPUTED, NOT STORED. The profile is a pure function of the assistant's
 * name plus the user's name, so:
 *  - it is IDENTICAL on every turn, on every device, for that pair — no DB write, no
 *    migration, no race, nothing to sync between chat and the voice call;
 *  - two different accounts genuinely like different things (it is not one canned
 *    personality shipped to everyone);
 *  - renaming the companion in Settings gives her a new set of likes, which users
 *    discover as a feature rather than a bug.
 * The persona text is deliberately NOT part of the seed: it is editable in Settings,
 * and re-rolling her favourites because someone retyped a style sentence would look
 * like she forgot them. Only the two names are stable enough to key a personality on.
 * A saved memory still wins: the prompt line below tells her that whatever the user
 * taught her ("remember ki mera fav colour green hai") overrides this list, so the
 * profile is a starting personality, not a cage.
 *
 * The pools are deliberately South-Asian-first with English options mixed in, because
 * the shipped audience chats in Hinglish/Urdu — and each entry is written the way it
 * should be SAID, so a Roman-Urdu reply can use it verbatim.
 */

/* FNV-1a over the seed, then a cheap LCG to draw from it. `Math.random` is not used
 * anywhere in this file on purpose: a random pick would mean she likes a different
 * song every message, which is worse than having no preferences at all. */
function hashSeed(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function rngFrom(seed) {
  let x = seed || 0x9e3779b9
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 0x100000000
  }
}

/** `k` distinct picks from `pool`, in a seeded order. */
function seededPick(pool, k, rand) {
  const items = [...pool]
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items.slice(0, k)
}

const POOLS = {
  song: [
    'Kun Faya Kun (Rockstar)', 'Pasoori (Coke Studio)', 'Afreen Afreen (Nusrat Fateh Ali Khan)',
    'Dil Diyan Gallan (Atif Aslam)', 'Tera Yaar Hoon Main (Tony Kakkar)', 'Tujhe Dekha Toh (DDLJ)',
    'Ae Dil Hai Mushkil (Arijit Singh)', 'Perfect (Ed Sheeran)', 'Yellow (Coldplay)',
    'Viva La Vida (Coldplay)', 'Let Her Go (Passenger)', 'Blinding Lights (The Weeknd)',
  ],
  fruit: ['aam (mango)', 'jamun', 'kinnow', 'tarbooz (watermelon)', 'anjeer (fig)', 'angoor (grapes)', 'anaar (pomegranate)', 'litchi', 'strawberry', 'kharbooja (melon)'],
  colour: ['gehra neela (midnight blue)', 'jamni (purple)', 'teal', 'sunehra (gold)', 'halka gulabi (rose pink)', 'safed (white)', 'hara (green)', 'sky blue', 'maroon'],
  drink: ['doodh patti chai', 'elaichi chai', 'coffee', 'cold coffee', 'nimbu paani', 'aam ka shake', 'green tea', 'lassi'],
  snack: ['garam samose', 'gol gappay', 'biryani', 'Maggi', 'kulfi', 'paranthe aur dahi', 'popcorn', 'chocolate', 'namak pare'],
  place: ['Kashmir', 'Tokyo', 'Istanbul', 'Switzerland ke pahar', 'Kerala ki backwaters', 'Naran-Kaghan', 'London', 'Bali', 'Paris', 'Hunza'],
  timeOfDay: ['baarish ki shaam', 'sardiyon ki dhund bhari subah', 'raat ka khamass waqt (late night)', 'sone se pehle ki golden hour', 'amhan ka waqt (dusk)'],
  hobby: ['shayari aur poetry parhna', 'sitare dekhna (astronomy)', 'nayi cheezein build karna', 'playlists banana', 'drawing aur sketching', 'cricket dekhna', 'naye languages seekhna', 'cooking experiments', 'photography'],
  story: ['sci-fi aur space ki kahaniyan', 'dimaag ghuma dene wale mysteries', 'feel-good dramas', 'purani Hindi classics', 'real-life incidents', 'animated films'],
  animal: ['billiyan (cats)', 'kutay (dogs)', 'dolphins', 'ullu (owls)', 'khargosh', 'ghoray'],
  /* One mild dislike is what makes a personality feel real — everything-loved
   * characters read as sales copy. Kept inoffensive on purpose. */
  dislike: ['thandi ho chuki chai', 'bohat slow internet', 'bheed-bhaad wali jagah', 'der raat tak ka shor', 'khatti cheezein', 'aadhi baat mein phone kaatna'],
  comfort: ['baarish + garam chai', 'sardi mein blanket aur book', 'raat ko chup chap kaam karna', 'purane gaane ki dhun', 'doston ke saath hansi-mazaak'],
}

/* Labels are written gender-neutral on purpose — Urdu/Hinglish verbs conjugate by the
 * speaker's gender and the prompt states that separately (see the GRAMMAR line in
 * config.systemPromptFor); a "pasand karta/karti" here would fight it. */
const FIELDS = [
  ['song', 'Pasand ka gaana'],
  ['fruit', 'Pasand ka phal'],
  ['colour', 'Pasand ka rang'],
  ['drink', 'Pasand ka peena'],
  ['snack', 'Pasand ka khana'],
  ['place', 'Pasand ki jagah'],
  ['timeOfDay', 'Sab se pasand ka waqt'],
  ['hobby', 'Shauq'],
  ['story', 'Pasand ki kahaniyon ka type'],
  ['animal', 'Pasand ka janwar'],
  ['dislike', 'Jo cheez tumhe PASAND nahi'],
  ['comfort', 'Cheez jo tumhe sukoon deti hai'],
]

/* Keys of a taste profile, exported so a test can walk every field instead of
 * hard-coding a list that would silently skip a newly added one. */
export const TASTE_FIELDS = FIELDS.map(([key]) => key)

/* Short labels for the spoken form. The long "Pasand ka gaana" phrasing reads well in
 * a text prompt, but the voice sheet is re-sent as context on every turn of a call, and
 * repeating one useless prefix twelve times is a third of the block. The values keep
 * their English glosses: a user whose reply language is English must still be able to
 * say "kinnow" or "jamni" back at her. */
const SPOKEN_LABELS = {
  song: 'gaana', fruit: 'phal', colour: 'rang', drink: 'peena', snack: 'khana', place: 'jagah',
  timeOfDay: 'waqt', hobby: 'shauq', story: 'kahani', animal: 'janwar', dislike: 'na-pasand', comfort: 'sukoon',
}

/**
 * Deterministic taste profile for one companion + one user pair — plain strings,
 * ready to print, stable for the life of the account.
 */
export function tasteFor({ assistantName, userName } = {}) {
  const seed = `${String(assistantName || 'Nexora').trim().toLowerCase()}|${String(userName || '').trim().toLowerCase()}`
  const rand = rngFrom(hashSeed(seed))
  const out = {}
  for (const [key] of FIELDS) {
    out[key] = seededPick(POOLS[key], 1, rand)[0].trim()
  }
  return out
}

/**
 * The prompt block. Two halves matter: the list itself, and the explicit
 * permission — a model that thinks a preference is a human claim will keep
 * deflecting no matter how good the list is.
 *
 * `spoken: true` is the shorter copy for the realtime voice sheet, which is billed
 * per turn and read aloud from: same permission, same list, fewer words.
 */
export function tastePromptBlock(taste, { spoken = false } = {}) {
  const t = taste || {}
  if (spoken) {
    const items = TASTE_FIELDS.map((key) => `${SPOKEN_LABELS[key]}: ${t[key]}`).join(' • ')
    return `YOUR OWN TASTES (real, and yours): ${items}. NEVER answer "what do you like?" with "main AI hoon isliye mujhe kuch pasand nahi" — you don't eat or hear the way a human does and you may say so, but you DO have favourites. Name one with a short in-character reason; never dodge, never recite the whole list. A memory the user gave you about your tastes wins over these.`
  }
  const items = FIELDS.map(([key, label]) => `${label}: ${t[key]}`).join(' | ')
  return `YOUR OWN TASTES — these are real, and naming them is NOT claiming a human experience, so NEVER answer "main AI hoon isliye mujhe kuch pasand nahi" or "as an AI I don't have feelings". You may not eat or hear the way humans do and you may say so — you still like things. ${items}. When asked what you like, ANSWER with your own pick in one line plus a reason that fits your character; never deflect and never only throw the question back. Never recite this list unprompted — one item, only when it fits. You may disagree playfully but never look down on their taste. A saved memory about your tastes beats this profile from then on (memory wins).`
}
