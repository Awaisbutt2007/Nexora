import { config, isLoopbackUrl } from '../config.js'

/* Thin, hardened client for the local desktop agent. It is the ONLY component
   that knows AGENT_SECRET, it only ever targets a loopback URL, and it always
   attaches a timeout so a hung agent can never wedge the request thread. Errors
   are normalised to { status, type, message } so the route can pass them on. */

function agentUnavailable(message) {
  const err = new Error(message)
  /* 503, not 502: the Nexora API itself is healthy — only the optional local agent is
     missing. The client treats a bare 502/504 as "backend offline", so a 502 here made
     an absent desktop agent look like the whole server was down. */
  err.status = 503
  err.type = 'desktop_agent_unavailable'
  throw err
}

export async function callAgent(route, { method = 'GET', body, timeoutMs = config.desktopAgentTimeoutMs } = {}) {
  if (!isLoopbackUrl(config.desktopAgentUrl)) {
    // Guard: refuse to proxy to any non-loopback host (SSRF pivot protection).
    const err = new Error('Desktop agent URL must be a loopback address.')
    err.status = 500
    err.type = 'misconfigured'
    throw err
  }
  if (!config.desktopAgentSecret) {
    const err = new Error('DESKTOP_AGENT_SECRET is not set — the desktop bridge is disabled. Set it in backend/.env to the agent’s AGENT_SECRET.')
    err.status = 503
    err.type = 'desktop_bridge_disabled'
    throw err
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${config.desktopAgentUrl}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.desktopAgentSecret}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      /* An action that RAN and FAILED is data, not a transport fault. The agent
       * answers a failed action with `{ ok:false, status, reason }`, and `reason` is
       * the one sentence the user needs ("the automation browser was closed", "Path
       * is outside the approved directories"). Flattening that to `Agent responded
       * 403` made a recoverable browser death read like a permission denial — and it
       * disagreed with the paired-browser client (agentExecute in src/api/agent.js),
       * which already passes such a body through as a result. */
      if (json && typeof json === 'object' && 'ok' in json && (json.status || json.reason)) return json
      // pass the agent's own structured error through, preserving its status
      const err = new Error(json?.error?.message || json?.reason || `Agent responded ${res.status}`)
      err.status = res.status
      err.type = json?.error?.type || 'desktop_agent_error'
      err.agentPayload = json
      throw err
    }
    return json
  } catch (err) {
    if (err.name === 'AbortError') agentUnavailable(`The desktop agent did not respond within ${timeoutMs}ms.`)
    if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED|could not connect/i.test(err.message || '')) {
      agentUnavailable('The desktop agent is not running on your PC. Start it with `npm run dev:agent` (from the repo root) and try again.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export const desktopAgent = {
  health: () => callAgent('/health'),
  apps: () => callAgent('/apps'),
  permissions: () => callAgent('/permissions'),
  grant: (payload) => callAgent('/permissions/grant', { method: 'POST', body: payload }),
  revoke: (payload) => callAgent('/permissions/revoke', { method: 'POST', body: payload }),
  plan: (payload) => callAgent('/actions/plan', { method: 'POST', body: payload }),
  execute: (payload) => callAgent('/actions/execute', { method: 'POST', body: payload }),
  stop: () => callAgent('/stop', { method: 'POST', body: {} }),
  audit: (limit = 50) => callAgent(`/audit?limit=${Number(limit) || 50}`),
  stats: () => callAgent('/stats'),
}

export default desktopAgent
