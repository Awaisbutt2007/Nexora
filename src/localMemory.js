/* On-device memory store for sessions that have no backend behind them (the
   static Vercel deploy, where sign-in falls back to a `local-` token). Same shape
   as GET/POST /api/memory so the Memory tab needs no special case, and the
   remember-detection mirrors backend/src/routes/chat.js so "yaad rakhna …" in
   chat saves a memory here exactly like it does on the full backend. */

const PREFIX = 'nexora_local_memories:'
const MAX_ITEMS = 200

function storeKey(owner) {
  return PREFIX + String(owner || 'me').toLowerCase()
}

function read(owner) {
  try {
    const list = JSON.parse(localStorage.getItem(storeKey(owner)) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function write(owner, list) {
  try { localStorage.setItem(storeKey(owner), JSON.stringify(list.slice(0, MAX_ITEMS))) } catch { /* storage full / private mode */ }
}

export function listLocalMemories(owner) {
  return read(owner).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function saveLocalMemory(owner, { key, value, source = 'user' }) {
  const k = String(key || '').trim().slice(0, 120)
  const v = String(value || '').trim().slice(0, 2000)
  if (!k || !v) throw new Error('Provide a key and a value.')
  const list = read(owner)
  const stamp = new Date().toISOString()
  const existing = list.find((m) => m.key.toLowerCase() === k.toLowerCase())
  if (existing) {
    Object.assign(existing, { value: v, source, updatedAt: stamp })
    write(owner, list)
    return { ...existing }
  }
  const item = { id: `mem_local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, key: k, value: v, source, createdAt: stamp, updatedAt: stamp }
  write(owner, [item, ...list])
  return item
}

export function deleteLocalMemory(owner, id) {
  write(owner, read(owner).filter((m) => m.id !== id))
}

const REMEMBER_KW = /(?:\bremember(?:\s+(?:that|this|it))?\b|\bkeep\s+in\s+mind\b|\bnote\s+(?:that|this)\b|\bsave\s+(?:that|this)\b|\bdon'?t\s+forget\b|\bya?a?d\s+ra[kc]h(?:o|na|ni|iye|iyega|ein|en|\s*l[oe])?\b)/i
const QUESTION_START = /^\s*(?:do|did|does|can|could|will|would|what|kya|kia|tum(?:he|hein)?\s+ya?a?d)\b/i

function cleanFact(s) {
  return String(s || '')
    .replace(/^[\s,:;\-–—]+|[\s,:;\-–—.!]+$/g, '')
    .replace(/^(?:that|this|ke|ki|k)\s+/i, '')
    .trim()
}

/** "remember that my birthday is 5 May" / "meri age 25 ha yaad rakhna" → the fact, else null. */
export function detectRememberRequest(text) {
  if (!text) return null
  const sentences = String(text).match(/[^.!?\n]+[.!?]?/g) || []
  for (const sentence of sentences) {
    const m = REMEMBER_KW.exec(sentence)
    if (!m) continue
    if (/\?\s*$/.test(sentence) || QUESTION_START.test(sentence)) continue
    const after = cleanFact(sentence.slice(m.index + m[0].length))
    const before = cleanFact(sentence.slice(0, m.index))
    const fact = after.length >= 3 ? after : before
    if (fact.length >= 3) return fact.slice(0, 500)
  }
  return null
}

/** Save a remember-request from a chat message; returns the stored item or null. */
export function rememberFromChat(owner, text) {
  const fact = detectRememberRequest(text)
  if (!fact) return null
  const key = fact.split(/\s+/).slice(0, 5).join(' ').slice(0, 60) || 'note'
  return saveLocalMemory(owner, { key, value: fact, source: 'user' })
}
