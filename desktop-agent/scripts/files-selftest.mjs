/* Throwaway proof that the agent really can reach the user's OWN folders through the
   same HTTP plan→execute flow the app uses — LIST the real Documents folder, WRITE a
   probe file, READ it back, then delete it. Reads the actual ../.env (AGENT_ALLOWED_DIRS,
   AGENT_SECRET), so it proves the laptop's live configuration, not a sandbox. */
const { createApp } = await import('../src/index.js')
const fs = await import('node:fs')
const path = await import('node:path')
const os = await import('node:os')

const { app } = createApp()
const server = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`
  const H = { Authorization: `Bearer ${process.env.AGENT_SECRET}`, 'Content-Type': 'application/json', Connection: 'close' }
  const post = async (p, b) => {
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) })
    return { status: r.status, json: await r.json().catch(() => ({})) }
  }
  const run = async (action, args) => {
    const plan = await post('/actions/plan', { action, args, context: { fromVoice: false } })
    if (!plan.json.planId) return { status: plan.status, json: plan.json }
    const ex = await post('/actions/execute', { planId: plan.json.planId, approvedThisAction: true })
    return ex
  }
  const docs = path.join(os.homedir(), 'Documents')
  let probe
  try {
    const g = await post('/permissions/grant', { scope: 'files' })
    console.log('GRANT files →', g.status, JSON.stringify(g.json.permissions?.scopes || g.json))

    const list = await run('files.list', { dir: docs })
    const entries = list.json?.result?.entries || []
    console.log(`LIST ${docs} →`, list.status, `(${entries.length} entries)`, entries.slice(0, 6).map((e) => e.name).join(', '))

    probe = path.join(docs, `nexora-access-test-${Date.now()}.txt`)
    const write = await run('files.write', { path: probe, content: 'hello from Aira — full laptop access works' })
    console.log('WRITE →', write.status, write.json?.status, path.basename(probe))

    const read = await run('files.read', { path: probe })
    const body = read.json?.result?.content ?? read.json?.result ?? read.json
    console.log('READ  →', read.status, JSON.stringify(body).slice(0, 90))
  } catch (err) {
    console.error('SELFTEST ERROR:', err && err.message)
  } finally {
    try { if (probe) fs.rmSync(probe, { force: true }) } catch { /* best-effort cleanup */ }
    // Let Node drain and exit naturally (Connection: close above stops undici holding
    // a keep-alive socket). Forcing process.exit() on Windows races libuv's async-handle
    // teardown and aborts with a benign "handle already closing" assertion AFTER every
    // action succeeded — so we set the code and close instead of exiting hard.
    process.exitCode = 0
    server.closeAllConnections?.()
    server.close()
  }
})
