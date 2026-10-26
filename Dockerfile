# syntax=docker/dockerfile:1
# Nexora — single-service image: builds the React app, then runs the Express +
# SQLite backend that ALSO hosts the built frontend (backend/src/config.js
# resolves clientDir to ../dist). One process, one origin, so a deployed page
# calls relative /api URLs and CORS can never break a request.

# ---------- Stage 1: build the Vite/React frontend ----------
FROM node:24-bookworm-slim AS webbuild
WORKDIR /app
# Install from the lockfile for reproducibility, exactly as docs/DEPLOYMENT.md asks.
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js index.html ./
COPY src ./src
COPY public ./public
RUN npm run build                      # -> /app/dist

# ---------- Stage 2: runtime (backend + hosted client) ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Backend production deps only (no dev tooling in the shipped image).
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci --omit=dev

# Backend source, then the freshly built client where config looks for it.
COPY backend/src ./backend/src
COPY --from=webbuild /app/dist ./dist

# PERSISTENT STATE. The SQLite file honours DB_PATH, so it goes on the mounted
# volume. The uploads dir is hardcoded to backend/uploads in code, so symlink it
# onto the same volume — otherwise uploaded images/voice samples vanish on
# restart. Hosts that give a disk (Railway volume / Render disk) mount /data.
RUN mkdir -p /data/uploads \
  && ln -s /data/uploads /app/backend/uploads
ENV DB_PATH=/data/nexora.db

# Render/Railway/Fly inject PORT; default 8787 for a plain `docker run`.
EXPOSE 8787
CMD ["node", "backend/src/index.js"]
