/* Self-reflection pass — the safety-critical properties, tested with NO network:
     1. in mock mode (no OPENAI_API_KEY) it is completely inert: it returns
        { skipped: 'mock' } and never touches the DB (so a dev/test box with no
        key can never quietly spend tokens or write memories);
     2. the JSON extractor tolerates code fences and junk without throwing;
     3. the transcript shaper keeps only the real exchange and trims it.

   Env is pinned BEFORE importing the module, exactly like api.test.mjs, because
   config.js reads process.env once at load. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.OPENAI_API_KEY = ''
process.env.JWT_SECRET = 'nexora-test-secret'
process.env.CORS_ORIGIN = 'http://localhost:5173'

const { maybeReflectOnConversation, parseJson, transcribe, REFLECT_EVERY } = await import('../src/services/selfReflect.js')

test('mock mode is inert — returns skipped:mock and never touches the DB', async () => {
  let dbTouched = false
  const db = {
    prepare: () => {
      dbTouched = true
      return { all: () => [], get: () => undefined, run: () => {} }
    },
  }
  const out = await maybeReflectOnConversation({ db, userId: 'usr_x', conversationId: 'conv_x' })
  assert.deepEqual(out, { skipped: 'mock' })
  assert.equal(dbTouched, false, 'must short-circuit before any DB access')
})

test('parseJson survives bare JSON, fenced JSON and non-JSON junk', () => {
  assert.deepEqual(parseJson('{"memories":[]}'), { memories: [] })
  assert.deepEqual(parseJson('```json\n{"memories":[{"key":"a","value":"b"}]}\n```'), { memories: [{ key: 'a', value: 'b' }] })
  assert.deepEqual(parseJson('Sure! Here is the result: { "memories": [] } — hope that helps.'), { memories: [] })
  assert.equal(parseJson('no object here at all'), null)
  assert.equal(parseJson(''), null)
  assert.equal(parseJson(null), null)
})

test('transcribe keeps only the user/companion turns and flattens whitespace', () => {
  const rows = [
    { role: 'user', content: 'do you  like\nmusic?' },
    { role: 'tool', content: 'ignore me' },
    { role: 'assistant', content: 'yes, a lot!' },
    { role: 'assistant', content: '' },
  ]
  const text = transcribe(rows)
  assert.equal(text, 'User: do you like music?\nCompanion: yes, a lot!')
})

test('REFLECT_EVERY is a sane throttle window', () => {
  assert.ok(Number.isInteger(REFLECT_EVERY) && REFLECT_EVERY >= 2)
})
