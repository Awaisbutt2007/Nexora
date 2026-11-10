/* Face mood bus: reads the feeling of a conversation turn (English, Roman Urdu,
   Urdu script and emoji) and holds it so the particle face can show it —
   a smile, a sad frown, an angry brow, a surprised look. The face reads
   moodWeights() every frame; the UI can subscribe to show the mood label.

   Moods: 'happy' | 'sad' | 'angry' | 'surprised' | 'neutral'. */

const LEXICON = {
  happy: [
    /(?:😀|😃|😄|😁|😆|😂|🤣|😊|😍|🥰|😘|😻|💖|💕|💗|❤|♥|🎉|🥳|✨|🌟|😇|🙂|☺)/u,
    /\b(haha+|hehe+|lol|lmao|yay|yaay|woo+hoo|great|awesome|amazing|wonderful|fantastic|glad|happy|happiness|love|lovely|congrat\w*|nice|cool|excited|enjoy\w*|fun|cute|beautiful|perfect|proud|thank(s| you)|welcome)\b/i,
    /\b(khush|khushi|mubarak|zabardast|shandar|kamal|wah|waah|shabash|maza|mazay|mazaa|pyar|pyaar|acha laga|achha laga|bohat acha|bahut acha|behtareen|hasna|hans|muskura\w*)\b/i,
    /(خوش|مبارک|زبردست|شاندار|کمال|واہ|شاباش|مزہ|پیار)/u,
  ],
  sad: [
    /(?:😢|😭|😞|😔|😟|🙁|☹|💔|🥺|😿|😥|😓)/u,
    /\b(sad|sorry|unhappy|miss(ing)?|alone|lonely|hurt|hurts|cry|crying|tears|pain|painful|depress\w*|upset|lost|grief|heartbroken|tired|exhausted|regret|unfortunately|afraid|worried|worry)\b/i,
    /\b(udaas|udas|dukh|dukhi|afsos|tanha|akela|akeli|rona|ro rahi|ro raha|takleef|dard|pareshan|pareshaan|maafi|maaf|mafi|gham|ghum|thak gay\w*|yaad aa\w*)\b/i,
    /(اداس|دکھ|افسوس|تنہا|اکیلا|رونا|تکلیف|درد|پریشان|معاف|غم)/u,
  ],
  angry: [
    /(?:😠|😡|🤬|👿|💢|😤)/u,
    /\b(angry|anger|mad|furious|annoyed|annoying|hate|irritat\w*|rude|stupid|idiot|shut up|how dare|nonsense|frustrat\w*|disgust\w*)\b/i,
    /\b(gussa|ghussa|naraz|naraaz|bakwas|bakwaas|chup kar\w*|chup ho|pagal|bewaqoof|bewakoof|tang|zaleel|badtameez)\b/i,
    /(غصہ|ناراض|بکواس|پاگل|بیوقوف|بدتمیز)/u,
  ],
  surprised: [
    /(?:😮|😯|😲|😱|🤯|😳|‼|⁉)/u,
    /\b(wow+|whoa+|woah|omg|oh my|really\?|seriously\??|no way|unbelievable|incredible|shocking|shocked|surpris\w*|what\?!|wait what)\b/i,
    /\b(sach mein|sach me|kya baat|haw+|hain\?|acha\?|achha\?|yaqeen nahi|kamaal hai)\b/i,
    /(واقعی|سچ میں|کیا بات|یقین نہیں)/u,
  ],
}

/** Score a piece of text. Returns { mood, strength 0..1 } (neutral when nothing fires). */
export function moodFromText(text) {
  const t = String(text || '')
  if (!t.trim()) return { mood: 'neutral', strength: 0 }
  let best = 'neutral'
  let bestScore = 0
  /* the heavier feelings are checked first so a tie never reads as "happy"
     (a comforting "you're not alone 💖" is not a cheerful message) */
  for (const mood of ['sad', 'angry', 'surprised', 'happy']) {
    const rules = LEXICON[mood]
    let score = 0
    for (const re of rules) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
      const hits = t.match(g)
      if (hits) score += hits.length
    }
    /* exclamation marks lift excitement (happy / surprised) a little */
    if ((mood === 'happy' || mood === 'surprised') && /!/.test(t)) score += 0.3
    if (score > bestScore) { bestScore = score; best = mood }
  }
  if (bestScore < 0.9) return { mood: 'neutral', strength: 0 }
  return { mood: best, strength: Math.min(1, 0.55 + bestScore * 0.15) }
}

/* ---- the live mood state the face reads ---- */
const MOODS = ['happy', 'sad', 'angry', 'surprised']
const target = { happy: 0, sad: 0, angry: 0, surprised: 0 }
const current = { happy: 0, sad: 0, angry: 0, surprised: 0 }
let currentMood = 'neutral'
let holdUntil = 0
let lastTick = 0
const listeners = new Set()

function notify() { listeners.forEach((fn) => { try { fn(currentMood) } catch { /* ignore */ } }) }

export function onMoodChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getMood() {
  return currentMood
}

/** Show a mood on the face for at least `holdMs` (then it relaxes to neutral). */
export function setFaceMood(mood, strength = 0.8, holdMs = 9000) {
  const m = MOODS.includes(mood) ? mood : 'neutral'
  MOODS.forEach((k) => { target[k] = k === m ? Math.max(0, Math.min(1, strength)) : 0 })
  holdUntil = performance.now() + holdMs
  if (m !== currentMood) { currentMood = m; notify() }
}

/** Convenience: read the mood of a reply (falling back to the user's words, so
    the face mirrors their feeling with empathy) and show it. */
export function feelTurn(replyText, userText = '', holdMs = 9000) {
  let r = moodFromText(replyText)
  const u = userText ? moodFromText(userText) : { mood: 'neutral', strength: 0 }
  /* empathy: when the user is hurting or upset, a warm reply ("you're not
     alone 💖") should show concern on her face, not a cheerful smile */
  const userHurting = u.mood === 'sad' || u.mood === 'angry'
  if (userHurting && (r.mood === 'happy' || r.mood === 'neutral')) {
    r = { mood: 'sad', strength: Math.max(0.65, u.strength * 0.85) }
  } else if (r.mood === 'neutral' && u.mood !== 'neutral') {
    /* otherwise mirror the user's surprise or joy */
    r = { mood: u.mood, strength: u.strength * 0.8 }
  }
  if (r.mood === 'neutral') {
    if (currentMood !== 'neutral' && performance.now() < holdUntil) return currentMood
    setFaceMood('neutral', 0, holdMs)
    return 'neutral'
  }
  setFaceMood(r.mood, r.strength, holdMs)
  return r.mood
}

/** Eased 0..1 weight per mood; call once per frame. */
export function moodWeights() {
  const now = performance.now()
  if (holdUntil && now > holdUntil) {
    MOODS.forEach((k) => { target[k] = 0 })
    holdUntil = 0
    if (currentMood !== 'neutral') { currentMood = 'neutral'; notify() }
  }
  const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0.016
  lastTick = now
  const k = 1 - Math.exp(-dt * 4)
  MOODS.forEach((m) => { current[m] += (target[m] - current[m]) * k })
  return current
}
