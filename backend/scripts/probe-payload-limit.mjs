/* Throwaway diagnostic: does the per-turn PAYLOAD SIZE explain "long chat → at its
   limit, new chat → fine"? Sends the real system prompt with a short history and then
   with a long one and prints only the outcome (never the key). Run:
     node scripts/probe-payload-limit.mjs
*/
import OpenAI from 'openai'
import { config, systemPromptFor } from '../src/config.js'
import { buildMessages } from '../src/services/ai.js'

const key = config.openaiApiKey
if (!key) {
  console.log('NO KEY — mock mode, cannot probe')
  process.exit(0)
}
const client = new OpenAI({ apiKey: key, baseURL: config.openaiBaseUrl })

const sys = systemPromptFor({ assistantName: 'Aira', userName: 'Awais', persona: '', language: 'hinglish', gender: 'female' })
console.log(`system prompt: ${sys.length} chars (~${Math.round(sys.length / 4)} tokens est.)`)

const turn = (i) => [
  { role: 'user', content: `Baatcheet ${i}: thora sa lamba sawal likh raha hoon taake history bhar jaye, jaise schedule file kholni hai ya YouTube pe kya hai, tum bata do` },
  { role: 'assistant', content: `Ji Awais, ${i} number ka jawab — main yahan hoon aur aapke sawal ka poora jawab de rahi hoon taake thread lambi hoti jaye aur payload bada ho.` },
]

async function attempt(label, history) {
  const messages = buildMessages(history, [], { assistantName: 'Aira', userName: 'Awais', language: 'hinglish', gender: 'female' }, null)
  const chars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
  try {
    const r = await client.chat.completions.create(
      { model: config.openaiModel, messages, max_tokens: 40 },
      { maxRetries: 0 },
    )
    console.log(`${label}: ${chars} chars → OK (prompt ${r.usage.prompt_tokens}, total ${r.usage.total_tokens})`)
  } catch (err) {
    const msg = String(err?.message || err).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 400)
    console.log(`${label}: ${chars} chars → FAIL status=${err?.status || '?'} code=${err?.error?.code || err?.code || '-'} :: ${msg}`)
  }
}

for (const turns of [1, 6, 12, 24]) {
  const hist = []
  for (let i = 1; i <= turns; i += 1) hist.push(...turn(i))
  hist.push({ role: 'user', content: 'akas' })
  await attempt(`turns=${String(turns).padStart(2)}`, hist)
}
process.exit(0)
