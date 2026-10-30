/* Throwaway diagnostic #2: what are the INPUT limits of each model in the chain?
   Two turns back to back per model — enough to expose a per-minute window — and the
   raw error text (which carries "Limit N"). Prints no key. */
import OpenAI from 'openai'
import { config, systemPromptFor } from '../src/config.js'

const client = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.openaiBaseUrl })
const sys = systemPromptFor({ assistantName: 'Aira', userName: 'Awais', language: 'hinglish', gender: 'female' })

const models = [config.openaiModel, ...(config.fallbackModels || [])]
/* ~12 turns of history, the size a "thori lambi chat" actually sends. */
const hist = []
for (let i = 1; i <= 12; i += 1) {
  hist.push({ role: 'user', content: `Sawal ${i}: thora lamba context taake history bhare, schedule file kholni hai YouTube bhi dekhna hai` })
  hist.push({ role: 'assistant', content: `Ji Awais ${i}, main jawab de rahi hoon taake thread lambi hoti jaye aur input tokens barhte jayen.` })
}
hist.push({ role: 'user', content: 'akas' })

for (const model of models) {
  const messages = [{ role: 'system', content: sys }, ...hist]
  for (let round = 1; round <= 2; round += 1) {
    try {
      const r = await client.chat.completions.create({ model, messages, max_tokens: 30 }, { maxRetries: 0 })
      console.log(`${model} [${round}] OK prompt=${r.usage.prompt_tokens} total=${r.usage.total_tokens}`)
    } catch (err) {
      const msg = String(err?.message || err).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').replace(/org_[0-9a-z]+/g, 'org_***')
      const limit = msg.match(/Limit (\d+)/)?.[1] || '?'
      const kind = msg.match(/on ([a-z ]+tokens per [a-z]+|input tokens)/i)?.[1] || msg.match(/maximum context length/i) ? 'ctx' : '?'
      console.log(`${model} [${round}] FAIL status=${err?.status} limit=${limit} kind=${kind} :: ${msg.slice(0, 200)}`)
    }
  }
}
process.exit(0)
