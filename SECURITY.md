# SECURITY.md — Nexora / Aira

How Nexora handles security, and how to report a problem.
For the findings and evidence of the last full audit, see
**`SECURITY_AUDIT_REPORT.md`**.

## Reporting a vulnerability
- **Do not open a public GitHub issue** for anything exploitable (the repo is
  public). Use a **private GitHub Security Advisory**
  (*Security → Report a vulnerability*) or the maintainer's private contact.
- Include: affected endpoint/file, steps to reproduce, impact, and a suggested fix
  if you have one. Redact any secret **values** — reference them by file/line and
  type only.
- We aim to acknowledge within 3 business days and ship a fix before disclosure.

## Threat model (what this app is)
A personal AI assistant: React/Vite browser app + an Express + SQLite backend + an
opt-in **local** desktop agent. It is multi-user on one backend and the desktop
agent runs on the same PC as the backend.

## Security invariants (enforced + regression-tested)
1. **Secrets never reach the browser.** Only `VITE_*` (public) values are bundled.
   Backend keys live in `backend/.env`, which is git-ignored.
2. `.env.example` files contain **placeholders only**; a real secret in a tracked
   file fails the CI gate.
3. **Production fails fast**: `backend/src/config.js` throws if `JWT_SECRET` is
   missing, is the shipped dev default, **or is shorter than 32 chars**, and if
   `CORS_ORIGIN` still points at localhost.
4. **Auth is on every data route** (`requireAuth`), and **ownership is checked**
   with `WHERE id = ? AND user_id = ?` on conversations, messages, memory, tool
   runs and voice prints (IDOR-safe).
5. **Rate limiting**: `authLimiter` on login/register/Google; `aiLimiter` per user
   on expensive AI endpoints (`/chat/completions`, `/proactive`, `/tools/:id/run`);
   a per-user cap on realtime voice sessions.
6. **SQL is always parameterized** (`node:sqlite` prepared statements).
7. **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
   `Referrer-Policy: no-referrer`, and HSTS in production. Errors are logged in
   full server-side but **redacted** to the client (no stack traces / internals).
8. **Uploads**: `multer` memory storage, 10 MB cap, extension allowlist, filenames
   regenerated with `nanoid` (no user-controlled path → no traversal).
9. **Desktop agent is least-privilege & loopback-only**: refuses a non-loopback
   bind, requires a shared bearer secret (≥16 chars, fail-closed 503 if unset),
   default-denies scopes, contains file paths by `realpath`, forces explicit
   confirmation for destructive actions, keeps an audit log, and the backend
   refuses any non-loopback agent URL (SSRF guard).
10. **Cloud web app + local agent (pairing)**: when the app is hosted, the browser
    drives the customer's own loopback agent **directly** (the cloud backend can never
    reach a remote `127.0.0.1`). Access is granted only via a console-only **pairing
    code** plus an **outbound paid-account check** (`GET /api/desktop-agent/entitlement`,
    `requireAuth`) before a per-install **client token** is minted. The agent still binds
    loopback-only and only makes *outbound* calls; a browser request must carry an
    `Origin` in `AGENT_ALLOWED_ORIGINS` (others get `403`), the shared `AGENT_SECRET`
    never reaches the browser, and only the token's SHA-256 hash is persisted. The
    same plan→execute, default-deny-scope and always-confirm gates apply.
11. **Image generation** enforces an NSFW blocklist before any provider call.
12. **The localhost token pass can never exempt a remote caller**: the shared daily
    provider-token budget may skip its gate for a request whose `req.ip` is loopback
    (`config.localUnlimitedTokens`), so the developer is not locked out of their own
    machine by their own testing. The address comes from the socket (or the proxy-
    forwarded client IP when `TRUST_PROXY` is on) — never from a header a page can
    forge — it is **forced off when `NODE_ENV=production`**, and tokens keep being
    tallied so the honest number survives. `backend/test/api.test.mjs` pins
    `LOCAL_UNLIMITED_TOKENS=0` and asserts both directions, so the gate can never be
    silently disabled by a developer's own `.env`.

## Secret handling & scanning
- A dependency-free, privacy-safe scanner runs locally and in CI:
  - `npm run security:scan` — working tree.
  - `npm run security:scan:history` — every Git blob ever committed.
  - `npm run security:check` / `:check:full` — also asserts no secret-bearing file
    (`.env`, `*.db`, `uploads/*.wav`, `*.pem/key`, `permissions.json`, `audit/`) is
    git-tracked.
  - It **never prints secret values** — only `head…tail (len, hash)` fingerprints.
- **Never** paste real keys into issues, PRs, logs, screenshots, or test fixtures.
- The GitHub Actions workflow (`.github/workflows/security.yml`) blocks a push/PR
  if any scan or test fails.

## Credential rotation
If a credential is ever exposed, **rotating it is the fix — deleting the file is
not**. Deletion does not revoke anything, and history keeps the old value. Rotate
at the provider dashboard, then confirm the new value is untracked. Steps per
provider are in `SECURITY_AUDIT_REPORT.md`.

## Dependencies
- `npm run audit:all` runs `npm audit --omit=dev` across all three packages.
- Update deps deliberately, re-run the full test suite after each bump.

## Pre-release checklist
- [ ] `npm run security:check:full` exits 0.
- [ ] `npm run build && npm run lint` clean (0 errors).
- [ ] Backend + desktop-agent tests green.
- [ ] `npm run audit:all` has no high/critical.
- [ ] Production env set: strong `JWT_SECRET`, real `CORS_ORIGIN`, real provider
      keys, `NODE_ENV=production`, `TRUST_PROXY=true` behind a load balancer.
- [ ] No new tracked file contains a secret.
