import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/* Dev/preview API proxy. The frontend talks to the backend through THIS server
   (relative /api and /uploads URLs — see API_BASE in src/api/nexora.js), so every
   request is same-origin and CORS cannot fail. That kills a whole class of
   "Failed to fetch" traps: Vite rolling to :5174/:5175 when a port is busy, opening
   the app through the printed Network URL (http://192.168.x.x:5173) or from a phone,
   and localhost vs 127.0.0.1 mismatches. A production build stays same-origin as well,
   because the backend serves dist/ itself. Point VITE_API_URL somewhere else only to
   bypass the proxy (e.g. a deployed backend). The default is the IPv4 LITERAL, not
   `localhost`: the backend binds `0.0.0.0` (IPv4 only — it never answers on `::1`), while
   Node resolves `localhost` to `::1` FIRST. When that first hop is refused or dropped the
   proxy surfaces it to the browser as a bare `Chat failed (502)` with no JSON body — the
   exact intermittent Windows failure a direct 127.0.0.1 test can never reproduce. */
const API_TARGET = process.env.VITE_API_URL || 'http://127.0.0.1:8787'
const apiProxy = Object.fromEntries(
  ['/api', '/uploads'].map((prefix) => [prefix, { target: API_TARGET, changeOrigin: true }]),
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: apiProxy,
    /* The dev server only needs to hot-reload src/, index.html and public/. It must NOT
       recurse into browser-profile or runtime-state folders that live inside the repo:
       their SQLite/journal files (Cookies, Cookies-journal, Sessions…, the .db-wal sidecars)
       are held EXCLUSIVE-LOCKED by the running browser / sqlite, so watching them throws
       `EBUSY: resource busy or locked` and floods the terminal. The desktop agent is a
       separate app (started by dev:agent), so it is ignored wholesale too. */
    watcher: {
      ignored: [
        '**/.tmp-*',              // stray browser temp profiles dropped in the repo root
        '**/*-profile/**',        // .tmp-edge-profile, desktop-agent/browser-profile, …
        '**/desktop-agent/**',    // the local agent has its own --watch process
        '**/backend/data/**',     // node:sqlite db + -wal / -shm runtime files
        '**/backend/uploads/**',  // user media
        '**/audit/**',
        '**/screenshots/**',
      ],
    },
  },
  preview: { proxy: apiProxy },
})
