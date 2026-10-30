/*
 * Direct transport to the customer's LOCAL Nexora Agent.
 *
 * Why this exists: the agent binds loopback-only, so a CLOUD-hosted backend can
 * never open a socket to a remote customer's 127.0.0.1:8799 — the classic
 * /api/desktop/* backend proxy only works when backend and agent share one
 * machine. For a hosted app the browser (which IS on the agent's machine) talks
 * to the agent DIRECTLY instead, authenticating with a per-install CLIENT TOKEN
 * minted through pairing. Everything here targets that local agent; the backend
 * proxy client in nexora.js stays untouched as the self-hosted fallback.
 *
 * The shared AGENT_SECRET never reaches the browser — only the client token,
 * which the agent trusts solely for requests carrying an allowlisted Origin.
 */
const AGENT_BASE = (import.meta.env.VITE_AGENT_URL || 'http://127.0.0.1:8799').replace(/\/+$/, '')
const TOKEN_KEY = 'nexora_agent_token'
const META_KEY = 'nexora_agent_meta'

/* ── client-token session (localStorage, mirrors the app's session-storage pattern) ── */
export function getAgentToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

export function getAgentMeta() {
  try { const raw = localStorage.getItem(META_KEY); return raw ? JSON.parse(raw) : null } catch { return null }
}

export function setAgentSession(token, meta) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    if (meta) localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch { /* private mode / quota — pairing just won't persist */ }
}

export function clearAgentSession() {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(META_KEY) } catch { /* ignore */ }
}

export function hasPairedAgent() { return Boolean(getAgentToken()) }

function agentHeaders(token = getAgentToken()) {
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

/* Same error shape as the backend/agent ({ error: { message, type } }). A fetch that
   never reached the agent (it isn't running, or the browser Origin isn't allowlisted so
   the CORS guard refused) must read as "start the agent", not a bare network stack trace. */
async function agentParse(res) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`)
    err.status = res.status
    err.type = data?.error?.type || null
    throw err
  }
  return data
}

function agentUnreachableText(err) {
  const msg = typeof err?.message === 'string' ? err.message : ''
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
    return `Can't reach the Nexora Agent at ${AGENT_BASE}. Run it on this PC with "npm run dev:agent", then reload.`
  }
  return msg
}

/* ── pairing (before a client token exists; origin-gated, no Authorization) ── */
export async function agentPairStatus() {
  const res = await fetch(`${AGENT_BASE}/pair/status`, { headers: { 'Content-Type': 'application/json' } }).catch((err) => { throw new Error(agentUnreachableText(err)) })
  return agentParse(res)
}

/* Redeem a console-only 6-digit code + the signed-in user's JWT for a client token.
   The agent verifies the code AND asks the cloud backend whether the JWT owns a paid
   account before it mints anything — so a wrong code, a signed-out user or a free
   account all come back as a typed 403 the pairing UI can explain. */
export async function agentPair(code, jwt) {
  const res = await fetch(`${AGENT_BASE}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: String(code || '').trim(), jwt }) }).catch((err) => { throw new Error(agentUnreachableText(err)) })
  const data = await agentParse(res)
  if (data.ok && data.token) setAgentSession(data.token, { agentId: data.agentId, userId: data.user?.userId, plan: data.user?.plan, expiresAt: data.expiresAt })
  return data
}

export async function agentRevoke() {
  const res = await fetch(`${AGENT_BASE}/pair/revoke`, { method: 'POST', headers: agentHeaders(), body: JSON.stringify({}) }).catch((err) => { throw new Error(agentUnreachableText(err)) })
  const data = await agentParse(res)
  clearAgentSession()
  return data
}

export async function agentInfo() {
  const res = await fetch(`${AGENT_BASE}/agent/info`, { headers: agentHeaders() })
  return agentParse(res)
}

/* ── agent actions — every call presents the stored Bearer client token ── */
export async function agentHealth() {
  // health never throws: an unreachable agent reads as { ok:false } so the UI can prompt to start it
  const res = await fetch(`${AGENT_BASE}/health`, { headers: { 'Content-Type': 'application/json' } }).catch((err) => { throw new Error(agentUnreachableText(err)) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, ...data }
}

export async function agentPermissions() {
  return agentParse(await fetch(`${AGENT_BASE}/permissions`, { headers: agentHeaders() }))
}

export async function agentApps() {
  return agentParse(await fetch(`${AGENT_BASE}/apps`, { headers: agentHeaders() }))
}

export async function agentGrant(payload) {
  return agentParse(await fetch(`${AGENT_BASE}/permissions/grant`, { method: 'POST', headers: agentHeaders(), body: JSON.stringify(payload) }))
}

export async function agentRevokePermission(payload) {
  return agentParse(await fetch(`${AGENT_BASE}/permissions/revoke`, { method: 'POST', headers: agentHeaders(), body: JSON.stringify(payload) }))
}

export async function agentPlan({ action, args = {}, context = {} } = {}) {
  return agentParse(await fetch(`${AGENT_BASE}/actions/plan`, { method: 'POST', headers: agentHeaders(), body: JSON.stringify({ action, args, context }) }))
}

export async function agentExecute({ planId, approvedThisAction = false } = {}) {
  const res = await fetch(`${AGENT_BASE}/actions/execute`, { method: 'POST', headers: agentHeaders(), body: JSON.stringify({ planId, approvedThisAction }) })
  // a denied execution comes back 403 with a structured body we still want to show
  const data = await res.json().catch(() => ({}))
  if (!res.ok && !data?.status) {
    const err = new Error(data?.error?.message || `Execute failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

export async function agentStop() {
  return agentParse(await fetch(`${AGENT_BASE}/stop`, { method: 'POST', headers: agentHeaders(), body: JSON.stringify({}) }))
}

export async function agentAudit(limit = 50) {
  return agentParse(await fetch(`${AGENT_BASE}/audit?limit=${Number(limit) || 50}`, { headers: agentHeaders() }))
}

/* The transport switch used by Nexora.jsx: a paired browser drives its own agent
   directly; with no token we fall back to the authenticated backend proxy (which
   only works when backend + agent share a machine, i.e. self-host / local-first). */
export function agentTransport() {
  if (!hasPairedAgent()) return null
  return { kind: 'agent', grant: agentGrant, plan: agentPlan, execute: agentExecute }
}

export { AGENT_BASE }
