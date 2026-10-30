import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

/* Loopback-only. The desktop agent drives a real browser and touches real files,
   so it must NEVER listen on a routable interface. "localhost" resolves to the
   loopback range; anything else (0.0.0.0, a LAN IP, a public bind) is refused at
   startup — this is a hard security gate, not a preference. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

function resolvePath(p, fallback) {
  const v = p && p.trim() ? p.trim() : fallback
  return path.isAbsolute(v) ? v : path.resolve(root, v)
}

function listFrom(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export const config = {
  host: process.env.AGENT_HOST || '127.0.0.1',
  port: Number(process.env.AGENT_PORT || 8799),
  nodeEnv: process.env.NODE_ENV || 'development',
  /* Shared secret with the backend. Empty by default → the server refuses to
     boot (and mutating routes reject every call) so an operator can never leave
     an unauthenticated automation endpoint running by accident. */
  secret: process.env.AGENT_SECRET || '',
  actionTimeoutMs: Math.max(1000, Number(process.env.AGENT_ACTION_TIMEOUT_MS || 60000)),
  /* Absolute roots the file layer may access. Populated from env at boot and
     extendable at runtime via the permission manager (still containment-checked). */
  allowedDirs: listFrom(process.env.AGENT_ALLOWED_DIRS).map((d) => path.resolve(d)),
  approvedAppIds: listFrom(process.env.AGENT_APPROVED_APP_IDS),
  browser: process.env.AGENT_BROWSER || 'headless chromium',
  browserProfileDir: resolvePath(process.env.AGENT_BROWSER_PROFILE, path.join(root, 'browser-profile')),
  allowedHosts: listFrom(process.env.AGENT_ALLOWED_HOSTS),
  auditDir: resolvePath(process.env.AGENT_AUDIT_DIR, path.join(root, 'audit')),
  dataDir: resolvePath(process.env.AGENT_DATA_DIR, path.join(root, 'data')),
  rootDir: root,
  /* Cloud web app + local agent: the browser talks to this agent DIRECTLY (it is on
     the same machine, so the loopback bind still holds). Two extra knobs make that
     safe — `allowedOrigins` is the CORS allowlist of web origins allowed to drive the
     agent (empty = only server-to-server calls with no Origin, i.e. the classic
     backend proxy), and `backendUrl` is the cloud API the agent calls OUTBOUND to
     verify a pairing browser really owns a paid account before it mints a token. */
  allowedOrigins: listFrom(process.env.AGENT_ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '')),
  backendUrl: (process.env.NEXORA_BACKEND_URL || '').trim().replace(/\/+$/, ''),
  /* Pairing: a short numeric code shown only on the agent's own console (never
     served over HTTP, so a remote site cannot read it) plus a client token valid
     for a bounded window. The code rotates so a stale glance can't be reused. */
  pairCodeTtlMs: Math.min(600000, Math.max(10000, Number(process.env.AGENT_PAIR_CODE_TTL_MS || 60000))),
  pairWindowMs: Math.min(3600000, Math.max(60000, Number(process.env.AGENT_PAIR_WINDOW_MS || 600000))),
  clientTokenTtlDays: Math.min(365, Math.max(1, Number(process.env.AGENT_CLIENT_TOKEN_TTL_DAYS || 30))),
}

/* Fail fast — before binding a socket — on the two mistakes that would silently
   expose an automation surface: a non-loopback bind, or a missing secret. Tests
   can opt out of the secret check (they mount their own ephemeral server and set
   a throwaway secret), so this only guards the real entry point. */
if (!LOOPBACK.has(config.host)) {
  throw new Error(
    `Refusing to bind the desktop agent to "${config.host}". It may only listen on a loopback address (127.0.0.1 / localhost / ::1).`,
  )
}

export function assertRuntimeSecretConfigured() {
  if (!config.secret || config.secret.trim().length < 16) {
    throw new Error(
      'AGENT_SECRET must be set to a strong value (≥16 chars) in desktop-agent/.env. The agent will not run an unauthenticated automation endpoint.',
    )
  }
}
