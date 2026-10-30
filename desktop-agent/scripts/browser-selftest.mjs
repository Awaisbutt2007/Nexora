/* Throwaway proof that the desktop agent can really drive a browser end-to-end
   through the same HTTP plan→execute flow the backend proxy uses. Forces headless
   so no window pops up during the automated run (the app itself stays headed). */
process.env.AGENT_BROWSER = 'headless chromium'
const { createApp } = await import('../src/index.js')
const { close } = await import('../src/browser.js')

const { app } = createApp()
const server = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`
  const H = { Authorization: `Bearer ${process.env.AGENT_SECRET}`, 'Content-Type': 'application/json' }
  const post = async (p, b) => {
    const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) })
    return { status: r.status, json: await r.json().catch(() => ({})) }
  }
  try {
    const grant = await post('/permissions/grant', { scope: 'browser' })
    console.log('GRANT browser →', grant.status, JSON.stringify(grant.json.permissions?.scopes || grant.json))
    const plan = await post('/actions/plan', { action: 'browser.open', args: { url: 'https://example.com' }, context: { fromVoice: false } })
    console.log('PLAN →', plan.status, JSON.stringify(plan.json))
    if (plan.json.planId) {
      const ex = await post('/actions/execute', { planId: plan.json.planId, approvedThisAction: true })
      console.log('EXECUTE →', ex.status, JSON.stringify(ex.json))
    }
  } catch (err) {
    console.error('SELFTEST ERROR:', err && err.message)
  } finally {
    await close().catch(() => {})
    server.close(() => process.exit(0))
  }
})
