# DEPLOYMENT.md — Nexora / Aira

Setup, production configuration, and a rollback plan. This is a **runbook**, not
an executed deploy — no deployment, publish, or paid usage was performed here
(that needs explicit approval, see `NEXT_STEPS.md`).

## Components & default ports
| Piece | Dir | Dev port | Run |
|---|---|---|---|
| Frontend (Vite) | repo root | 5173 | `npm run dev` (starts with API) |
| Backend (Express + SQLite) | `backend/` | **8787** | `npm run dev` (starts with frontend) |
| Desktop agent (optional, local) | `desktop-agent/` | **8799** | `npm --prefix desktop-agent start` — loopback only |

The desktop agent is **optional** and must stay on the same machine as the
backend (127.0.0.1). It fails closed if no shared secret is configured.

## 1. Local setup
```bash
npm install
npm --prefix backend install
npm --prefix desktop-agent install        # only if using the desktop agent

cp .env.example .env                       # frontend: VITE_API_URL, VITE_GOOGLE_CLIENT_ID
cp backend/.env.example backend/.env       # backend secrets (never committed)
# (optional) cp desktop-agent/.env.example desktop-agent/.env

npm run dev                                # frontend on :5173 + backend on :8787
```
Mock mode works with **no** provider keys (chat/tools/credits run against a
deterministic mock). Realtime voice and real model answers need `OPENAI_API_KEY`.

## 2. Production environment (backend)
Set in the host's secret manager (never in git):

| Var | Requirement |
|---|---|
| `NODE_ENV` | `production` — enables the fail-fast guards + HSTS + error redaction. **It also force-disables the demo auth bypass (`AUTH_OPEN_MODE`) and gates self-service plan upgrades behind billing.** If you deploy WITHOUT setting it, the server runs in development mode: any email/password signs in, unlimited Pro credits can be minted for free, and the JWT/CORS boot guards never fire. Always set it. |
| `JWT_SECRET` | **≥ 32 chars, random**. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. The app **refuses to boot** on a missing/default/short secret. |
| `CORS_ORIGIN` | The real frontend origin(s), comma-separated. **Must not** be localhost (boot fails otherwise). |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Real provider for live answers; leave key empty → mock. |
| `GOOGLE_CLIENT_ID` | To enable Google Sign-In (audience is verified server-side). |
| `TRUST_PROXY` | `true` **only** behind a reverse proxy/LB, so the rate limiter sees real client IPs. |
| `DB_PATH` | Absolute, writable, **backed-up** path for the SQLite file. |
| `DESKTOP_AGENT_URL` / `DESKTOP_AGENT_SECRET` | Only if using the agent; URL must be loopback. |
| `AUTH_RATE_LIMIT`, `AI_RATE_LIMIT_PER_MIN`, `VOICE_RATE_LIMIT_PER_10MIN` | Tune abuse limits. |

The frontend build only ever inlines `VITE_*` values (public). Confirm no backend
secret has a `VITE_` prefix.

## 3. Build & serve
```bash
npm run build                       # -> dist/ (static; host on a CDN or any static server)
npm --prefix backend start          # API on :8787 (put behind nginx/caddy or a PaaS)
```
- Serve `dist/` over **HTTPS** only.
- Point the frontend's `VITE_API_URL` at the public API origin, and allow that same
  origin in backend `CORS_ORIGIN`.
- Put TLS termination + HSTS at the proxy (HSTS is also emitted by the app in prod).
- Install from lockfiles (`npm ci`) in CI deploys for reproducibility.

## 3a. One-service container deploy (fastest path to a public URL)

Because the backend already **hosts the built frontend** (`clientDir` = `../dist`),
the whole product ships as **one image on one URL** — the page calls relative
`/api` on its own origin, so CORS can never break a request. The repo now carries
`Dockerfile` (multi-stage: build Vite client → run `node backend/src/index.js`),
`.dockerignore` (never bakes `node_modules`, the local DB/uploads, or any `.env`),
and `render.yaml` (a Render blueprint). A production boot was verified locally: it
clears the JWT/CORS guards and serves `/health` 200, `/` 200 `text/html`, and
`/api/chat/quota` 401 all on the single port.

**Pick a host that runs a long-lived Node process with a persistent disk.** This
app needs all three: the SQLite file, Server-Sent-Events chat streams, and the
in-process reminder scheduler are incompatible with serverless static hosts
(Vercel/Netlify can serve the *frontend* only — deploying it alone yields a site
whose `/api` calls hit nothing). Use Render, Railway, Fly.io, or any container VM.

- **SQLite persistence is mandatory.** Point `DB_PATH` at a mounted volume and put
  uploads on it too. The image uses `/data` (`DB_PATH=/data/nexora.db`) and
  symlinks `backend/uploads` onto `/data/uploads`. A host that gives no disk (e.g.
  Render's free tier) wipes accounts/chats on every restart — attach a persistent
  disk/volume (Render disk, Railway volume, Fly volume).
- **Env to set in the host dashboard** (never in git): `NODE_ENV=production`, a
  random `JWT_SECRET` (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`),
  `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`, `OPENAI_MODEL`, `AI_FALLBACK_MODELS`,
  `AI_DAILY_TOKEN_LIMIT`), and `CORS_ORIGIN` = the service's public `https://…`
  URL. `CORS_ORIGIN` can't be known before the first deploy, so set it right after
  and redeploy (the boot fails on a localhost origin on purpose).
- **Render (Git-connected):** New → Blueprint → connect this repo; it reads
  `render.yaml`, builds `Dockerfile`, mounts the disk, gives you a URL. Fill the
  two `sync: false` secrets (`OPENAI_API_KEY`, `CORS_ORIGIN`) in the dashboard.
- **Railway:** `npm i -g @railway/cli`, `railway login`, `railway up`; add a volume
  at `/data` and the env vars above.
- **Fly.io:** `fly launch`/`fly deploy` from the `Dockerfile`; create a volume
  mounted at `/data` (`fly volumes create nexora_data --path /data`).

## 4. Pre-deploy gate (must be green)
```bash
npm run security:check:full   # secrets + tracked-file guard, incl. Git history
npm run build && npm run lint
npm test && npm run test:agent
npm run audit:all
```

## 5. Database, backups & migration notes
- Engine: **SQLite** (`node:sqlite`), single file at `DB_PATH`
  (default `backend/data/nexora.db`, WAL mode — back up the `-wal`/`-shm` too or
  checkpoint first). Schema is created in code (`backend/src/db/index.js`);
  there is **no automated migration runner yet** (see `NEXT_STEPS.md` P2-11).
- **Back up before every deploy**:
  ```bash
  sqlite3 "$DB_PATH" ".backup 'backup-$(date +%F-%H%M).db'"   # safe online copy
  ```
- Account deletion / retention jobs are not automated yet — document the manual
  steps until P2-12 lands.
- If a **multi-instance** deploy is required, SQLite (single writable node) is the
  bottleneck; plan a tested Postgres migration rather than running multiple writers.

## 6. Rollback
1. Stop the new release; redeploy the previous build artifact + previous
   `backend/` code (env secrets are unchanged).
2. If the DB was touched, restore the pre-deploy `*.backup` file to `DB_PATH`.
3. `npm --prefix backend start` on the prior version; verify `/health` and a mock
   chat round-trip.
4. Because deploys are additive and the app fails fast on bad prod env, a failed
   boot leaves the previous instance safe to re-enable.

## 7. What is NOT yet ready for production
- A container path now exists (`Dockerfile` + `render.yaml` + `.dockerignore`), but
  **no deploy has been executed** — pointing the service at a real host, generating
  a production `JWT_SECRET`, and pasting the provider key are manual, credential- and
  billing-bearing steps that need the operator to sign in to the chosen host.
- `/health` answers with readiness only; never set `HEALTH_VERBOSE=1` in a public
  deployment (it puts the engine and voice model ids back into that public response).
- No metrics/alerting; provider timeouts on AI calls are default (`NEXT_STEPS.md` P0-3).
- Realtime voice / Google Sign-In / image gen are unverified without live keys.
- **Speaker verification is NOT a gate on voice calls.** Calls authenticate with the
  signed-in user's JWT only. `POST /api/voice/verify` is a standalone enroll/compare
  feature; without a real `SPEECHBRAIN_URL` x-vector service it falls back to a local
  DSP embedding that is demo-grade (it can report `matched:true` on non-speech audio),
  so it must not be trusted as identity proof, and it is not wired into the call flow.
- **Payments are not live.** `/api/user/upgrade` is refused (503) in production until a
  real provider is configured; wiring Stripe (or similar) + a signature-verified webhook
  is a manual step that needs credentials.
