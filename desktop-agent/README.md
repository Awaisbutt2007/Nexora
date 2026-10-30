# Nexora Desktop Agent

A small, **local-only** Node service that lets the Aira assistant perform tasks you
authorize on **your own Windows PC** — driving a dedicated automation browser,
launching approved apps, and reading/organizing files inside folders you have
explicitly allowed. It is the "hands" of Aira; the model only ever *proposes* an
action, and this agent — not the model — decides whether it is allowed.

> This component is **opt-in and local**. It ships disabled: it refuses to start
> without a shared secret, and it refuses to bind to anything except `127.0.0.1`.
> Nothing here installs a Windows service, touches UAC, or runs at boot.

---

## 1. Security model (the guarantees)

| Guarantee | How it is enforced |
|---|---|
| **Loopback only** | `config.js` refuses to boot unless `AGENT_HOST` is `127.0.0.1` / `localhost` / `::1`. No LAN/public bind is possible. |
| **Authenticated** | Every mutating route requires `Authorization: Bearer <AGENT_SECRET>`. Missing secret → routes `503` (fail-closed); wrong token → `401`. The browser never learns this secret. |
| **No arbitrary execution** | There is no shell endpoint. Actions come from a fixed **allowlist** (`allowlist.js`); unknown actions are rejected. Apps launch via `execFile` with fixed argv from an executable map — never a command string. |
| **Default-deny permissions** | Six scopes — `browser`, `files`, `apps`, `system`, `screen`, `desktop` — all start **off**. An action needs its scope granted *and*, for destructive actions, an explicit per-action approval. |
| **Preview before act** | Two-step `plan` → `execute`. `plan` validates + returns a human-readable preview and a short-lived `planId` (5-min TTL, single-use). |
| **Always-confirm** | Delete/overwrite, form submit, restart, shutdown — and typing text or pressing a key combination — require explicit approval even when the scope is granted. |
| **Voice cannot arm power** | `system.restart` / `system.shutdown` are rejected when the request came from voice (`fromVoice: true`). |
| **File containment** | Reads/writes are confined to allowed dirs, checked **after** `realpath` (symlink/traversal escapes throw `PathEscapeError`). |
| **Redacted audit** | `audit/*.jsonl` records events, never result bodies. Secret-shaped keys (`password`, `token`, `cookie`, `value`, `content`, …), bearer tokens and long hex strings are masked. |
| **No credential handling** | It never reads, stores, types or reveals your Windows password, and never bypasses the lock screen or Windows Hello. If the session is locked, interactive actions simply fail and tell you. |
| **Dedicated browser profile** | Automation uses its own `browser-profile/`, never your real browser. It does not export cookies, saved passwords, or session tokens. |

---

## 2. Architecture

```
┌────────────┐   JWT     ┌──────────────────────┐  Bearer AGENT_SECRET  ┌─────────────────────┐
│  Browser   │ ────────► │  Aira backend :8787  │ ───── loopback ─────► │  Desktop agent :8799  │
│  (React)   │  /api/*   │  /api/desktop/* proxy│  http://127.0.0.1     │  (this folder)        │
└────────────┘           │  requireAuth + zod   │                       │  allowlist + perms    │
   no secrets here        └──────────────────────┘                       │  Playwright / apps /  │
                                                                         │  files / system       │
                                                                         └─────────────────────┘
```

- The **frontend** talks only to the Aira backend with your normal login JWT.
- The **backend** (`/api/desktop/*`) re-checks auth, then forwards to the agent over
  loopback using a server-side shared secret. It refuses a non-loopback
  `DESKTOP_AGENT_URL` (so the proxy can't be turned into an SSRF pivot).
- The **agent** validates against the allowlist, applies the permission gate, runs
  the action under a timeout, and writes a redacted audit line.

Ports: agent `8799`, backend `8787`, frontend dev `5173`.

---

## 3. Prerequisites

- **Node.js ≥ 22** (uses the built-in test runner and `node:sqlite` on the backend).
- Windows for the desktop actions themselves (the agent runs cross-platform for dev,
  but `apps`/`system` power actions are Windows-aware).
- For browser automation only: Playwright + one Chromium download (see §5).

---

## 4. Install

From the repository root, this folder is `desktop-agent/`.

```powershell
cd desktop-agent
npm install
```

`playwright` is an **optional** dependency: the agent boots and its tests pass
without it. Browser actions degrade with a clear "install it" message until you run
the next step.

### Enable browser automation (optional)

```powershell
npm run browsers:install      # downloads Chromium + headless shell into the Playwright cache
```

---

## 5. Configure

Copy the template and fill it in. `.env` is git-ignored; only `.env.example` is committed.

```powershell
copy .env.example .env
notepad .env
```

Key settings (see `.env.example` for the full annotated list):

| Variable | Meaning |
|---|---|
| `AGENT_HOST` | Must stay a loopback address. Non-loopback → the agent refuses to start. |
| `AGENT_PORT` | Local port, default `8799`. |
| `AGENT_SECRET` | Shared secret, **required**, ≥ 16 chars. Generate one below. |
| `AGENT_ACTION_TIMEOUT_MS` | Per-action timeout (default 60000). |
| `AGENT_ALLOWED_DIRS` | Absolute folder(s) file actions may touch. Empty = file access denied. |
| `AGENT_APPROVED_APP_IDS` | Which mapped apps may launch, e.g. `vscode,chrome,notepad`. |
| `AGENT_ALLOWED_HOSTS` | Optional origin allowlist for the browser. Empty = any public http(s). |

Generate a strong secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put that value in `desktop-agent/.env` as `AGENT_SECRET`.

---

## 6. Connect Aira to the agent

The backend and the agent must share the same secret.

1. Open `backend/.env` and set:
   ```
   DESKTOP_AGENT_URL=http://127.0.0.1:8799
   DESKTOP_AGENT_SECRET=<the SAME value as AGENT_SECRET>
   ```
   (`DESKTOP_AGENT_URL` must be loopback or the backend refuses to proxy.)
2. Start the agent (see §7) and (re)start the backend so it picks up the new env.
3. In the app, open the **Desktop** tab in the top bar. The status pill should read
   **"● Connected — 127.0.0.1:8799 · loopback only."** If it reads "OFF", the
   banner shows the real reason (no secret / agent not running).

The frontend needs no secret — it authenticates to the backend with your normal login.

---

## 6b. Cloud web app + local agent (pairing)

The flow above (§6) is **local-first / self-hosted**: the backend and the agent run on
the *same* machine, so the backend can proxy to `http://127.0.0.1:8799`. That stops
working the moment the app is hosted in the cloud — a remote server opening
`127.0.0.1:8799` reaches *its own* loopback, never your PC.

So for a **hosted** Nexora the browser talks to this agent **directly** (it is on the
same machine as you, so loopback still holds), and access is granted through a
**pairing code** plus a **paid-account check**:

```
Browser (cloud origin) ──pair code + your JWT──►  local Agent :8799
        ▲                                             │ verifies JWT/entitlement
        │  Bearer <client token>  (all action calls)  ▼
        └──────────────────────────  cloud backend  GET /api/desktop-agent/entitlement
```

1. **Start the agent** (§7). It prints a 6-digit **pairing code** to its console and
   rotates it periodically. The code is *never* served over HTTP — the console is the
   out-of-band anchor, so a random website cannot read it.
2. In the app's **Desktop** view, click **Connect your PC**, type that code, and
   confirm. The app sends the code + your login JWT straight to the local agent.
3. The agent calls the cloud backend **outbound** to check the JWT owns a **paid**
   (premium / non-free) account. Entitled → it mints a per-install **client token**
   (returned once, stored in the browser); not entitled → the pair is refused.
4. Every action the AI proposes then goes **browser → agent** with that Bearer token,
   through the exact same `plan → execute`, default-deny-scope and always-confirm
   gates as before. **Revoke this PC** (in the app, or `POST /pair/revoke`) deletes
   the token immediately; tokens also expire after `AGENT_CLIENT_TOKEN_TTL_DAYS`.

**What makes this safe** (the guarantees above still hold, plus):

- **Loopback bind is unchanged** — the agent still listens only on `127.0.0.1`; the
  browser reaches it because the browser is on the same PC. The agent only ever makes
  *outbound* calls to the backend, never inbound listeners on a public interface.
- **Origin allowlist + CORS** — a browser request must carry an `Origin` listed in
  `AGENT_ALLOWED_ORIGINS`; any other site the user visits gets a `403`. A client token
  is honoured *only* from an allowlisted Origin. (A no-Origin server-to-server call —
  the classic backend proxy — is still accepted, gated by `AGENT_SECRET`.)
- **The shared `AGENT_SECRET` never reaches the browser** — the browser only ever
  holds its own revocable client token, and only its SHA-256 hash is stored on disk.
- **Paid gate at pair time** — a signed-out, expired or downgraded-to-free session
  cannot obtain a token. (MVP checks once when pairing + honours the token TTL; it
  does not re-verify entitlement on every action.)

To enable it, set `AGENT_ALLOWED_ORIGINS` (your hosted app origin **and** the local
dev origin) and `NEXORA_BACKEND_URL` in `desktop-agent/.env` — both empty keeps
browser pairing off and leaves only the §6 backend-proxy path. See `.env.example`.

---

## 7. Start / Stop

### Start

```powershell
# from repo root
npm run dev:agent      # node --watch (auto-restart while developing)
# or
npm run start:agent    # plain run
# or, from inside desktop-agent/
npm start
```

You should see:

```
Nexora desktop agent listening on http://127.0.0.1:8799 (loopback only)
```

The agent **refuses to start** if `AGENT_SECRET` is missing/short or `AGENT_HOST` is
not loopback. That is intentional.

### Stop

Press `Ctrl+C` in the agent's terminal. The `SIGINT`/`SIGTERM` handler closes the
automation browser before exiting. To stop a just-approved restart/shutdown, use the
**Stop** button in the Desktop view (it runs `shutdown /a`), or run
`shutdown /a` yourself in a terminal.

---

## 8. Grant & revoke permissions

Everything is default-deny. Manage it from the **Desktop → Permissions** tab in the
app, or with the agent's HTTP API directly (shown with `curl`, token in
`Authorization: Bearer <AGENT_SECRET>`):

```powershell
# Grant a scope
curl -X POST http://127.0.0.1:8799/permissions/grant -H "Authorization: Bearer <SECRET>" -H "Content-Type: application/json" -d "{\"scope\":\"browser\"}"

# Allow a folder for file actions
curl -X POST http://127.0.0.1:8799/permissions/grant -H "Authorization: Bearer <SECRET>" -H "Content-Type: application/json" -d "{\"allowedDir\":\"D:\\\\NexoraPlayground\"}"

# Revoke a scope
curl -X POST http://127.0.0.1:8799/permissions/revoke -H "Authorization: Bearer <SECRET>" -H "Content-Type: application/json" -d "{\"scope\":\"files\"}"
```

Grants persist to `data/permissions.json` (git-ignored). Revoke anything you no
longer need. Even with a scope granted, always-confirm actions (submit, delete,
overwrite, restart, shutdown) still require a per-action approval.

### Running an action (the safe flow)

1. **Plan** — `POST /api/desktop/plan { action, args, context }` → returns a preview,
   the permission posture (`needsScope`, `needsConfirm`) and a short-lived `planId`.
2. **Approve** — you review the preview in the app.
3. **Execute** — `POST /api/desktop/execute { planId, approvedThisAction: true }`.
   The plan is single-use and expires in 5 minutes, so a stale preview can't be
   replayed.

---

## 9. Updating

```powershell
cd desktop-agent
npm install                 # refresh deps
npm run browsers:install    # only if Playwright prompts for a new browser build
```

Then restart the agent (`Ctrl+C`, start again). No database or service to migrate.

---

## 10. Uninstalling

Nothing is installed system-wide and no service or startup entry is created.

1. Stop the agent (`Ctrl+C`).
2. Remove the secret from `backend/.env` (`DESKTOP_AGENT_SECRET`) and restart the
   backend — the Desktop bridge goes back to fail-closed (OFF).
3. Delete this `desktop-agent/` folder if you want it gone entirely.
4. Optional: delete the Playwright browser cache at
   `%LOCALAPPDATA%\ms-playwright` to reclaim the Chromium download.

Personal runtime state (`data/`, `audit/`, `browser-profile/`, `screenshots/`) is all
inside this folder and safe to delete.

---

## 11. Capability matrix

| Capability | Action id(s) | Scope | Status |
|---|---|---|---|
| Launch approved browser, open/navigate | `browser.open` | browser | Implemented — **verified live** (Playwright) |
| Search engine | `browser.search` | browser | Implemented (uses engine allowlist) |
| Extract page text | `browser.snapshot` | browser | Implemented — **verified live** |
| Click / fill | `browser.click`, `browser.fill` | browser | Implemented |
| Submit (irreversible) | `browser.submit` | browser | Implemented — **always-confirm**, verified blocked without approval |
| Screenshot | `browser.screenshot` | browser | Implemented — **verified live** (wrote a real PNG) |
| Launch / close approved app | `apps.launch`, `apps.close` | apps | Implemented (fixed executable map, no shell) |
| List / read / write / organize files | `files.*` | files | Implemented — containment enforced; write refuses overwrite; organize is dry-run unless `apply` |
| System info | `system.info` | system | Implemented — **verified live** (real OS facts) |
| Restart / shutdown | `system.restart`, `system.shutdown` | system | Implemented — **always-confirm + voice-blocked** |
| Screen observation | `screen.capture` | screen | Implemented — .NET/PowerShell capture; ephemeral (saved only on request). Allowlist + gating **unit-tested**; live capture is a **manual Windows step** (real screen required) |
| Mouse / keyboard control | `desktop.move`, `desktop.click`, `desktop.scroll`, `desktop.type`, `desktop.key` | desktop | Implemented — coords validated vs the real screen, safe-combo allowlist, `type`/`key` always-confirm, no Win/Ctrl+Alt+Del surface. Validation + gating **unit-tested**; real input is a **manual Windows step** |
| Vision inspection | backend `/api/desktop/screen/inspect` | screen | Implemented — captures, sends the image to the vision model, returns a TEXT report only (image never stored); on-screen text is treated as untrusted |
| Emergency stop | `POST /stop` | — | Implemented (cancels running actions, recalls a scheduled power action) |
| Natural-language → action | backend `/api/desktop/intent` | — | Implemented (model proposes; agent still validates) |

> Browser actions require the Playwright browser (`npm run browsers:install`). Without
> it, they fail with a clear message rather than crashing the agent.

---

## 12. Testing

```powershell
# Agent suite (allowlist rejection, containment, default-deny, timeouts/cancel,
# audit redaction, voice-power block, plan no-replay, HTTP auth)
cd desktop-agent
npm test

# Backend bridge tests (auth 401, fail-closed 503, intent validation)
cd ../backend
npm test
```

Both use Node's built-in test runner — no extra dependencies, no network, no paid
calls. The agent tests mount an ephemeral loopback server with a throwaway secret.

---

## 13. Troubleshooting

- **"Refusing to bind …"** — `AGENT_HOST` is not loopback. Set it to `127.0.0.1`.
- **"AGENT_SECRET must be set …"** — copy `.env.example` to `.env` and set a ≥16-char secret.
- **Desktop tab shows "OFF"** — the agent isn't running, or `DESKTOP_AGENT_SECRET` in
  `backend/.env` doesn't match `AGENT_SECRET`, or the backend wasn't restarted after
  setting it. The banner shows the specific reason.
- **`ECONNREFUSED` from the backend** — the agent isn't listening on the configured
  port; start it, or fix `DESKTOP_AGENT_URL`.
- **Browser actions say Playwright is missing** — run `npm run browsers:install`.
- **A file action is denied** — the path isn't under an allowed dir, or the `files`
  scope isn't granted. Grant the folder in the Permissions tab.

---

## 14. What this deliberately does NOT do

- No unrestricted shell, filesystem browsing, or arbitrary command execution. (Screen
  and mouse/keyboard control exist, but only as the fixed, default-deny, coordinate-
  validated `screen.*`/`desktop.*` actions above — never a free-form command.)
- No reading/exporting browser passwords, cookies, or session tokens.
- No storing, requesting, revealing, or auto-typing your Windows password.
- No bypassing the lock screen, Windows Hello, UAC, Defender, or endpoint protection.
- No power action from an ambiguous voice command.
- No silent privilege escalation, no system service, no start-on-boot.

If a task genuinely needs elevation, the agent will not fake it — it will tell you to
perform the step yourself in an authorized, unlocked session.
