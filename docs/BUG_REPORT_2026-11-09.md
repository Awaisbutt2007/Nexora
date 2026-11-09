# Nexora — Deep Test Bug Report (2026-11-09)

**How it was tested:** lint, backend tests (114 tests, 5 runs), desktop-agent tests (50), production build,
2 API probe scripts against an isolated backend (temp DB, port 8790) covering every route, a full UI pass
in Chrome (sign-up → onboarding → chat → memory → schedule → tools → desktop → settings), and read-only
checks of the live Vercel site.

**Overall:** build OK, desktop-agent tests 50/50, backend tests 114/114 in 4 of 5 runs (1 flaky failure),
lint 0 errors / ~45 warnings.

---

## 🔴 CRITICAL

1. **The live site (Vercel) has no backend.** `nexora-opal-beta-29.vercel.app/api/auth/*` returns 404, and the
   bundle contains no Render URL (`VITE_API_URL` was not set at build time). Live sign-up/login, memory,
   schedule, tools, credits, voice and desktop do not work. Only chat works, through the Edge function.
   Fix: deploy the Render backend, then set `VITE_API_URL` in Vercel and rebuild.
2. **Free credits run out after 2 messages.** Every chat sends a ~3,600-token system prompt.
   `backend/src/services/ai.js:442` charges 1 credit per 100 tokens, so one "hi" costs about 37–41 credits out of 50.
   Seen in the UI too: 50 → 9 after the first message.
3. **No monthly refill.** The variable is called `FREE_MONTHLY_CREDITS`, but no code ever refills credits.
   Once credits hit 0, a free user is locked out for good.
4. **The Vercel chat endpoint is public and open** (`api/chat/completions.js`). It has no auth and no rate limit,
   so anyone can call it with POST and burn your Groq key.
5. **The shared demo account leaks data.** "Continue as Demo" signs every visitor into the same
   `demo@nexora.ai` account, with the password hardcoded in `src/SignIn.jsx:155`. All visitors see each other's
   chats and memories and share the same 50 credits.
6. **"Forgot password" is fake.** `src/SignIn.jsx:170` shows "Password reset link sent to …", but nothing is
   sent and the backend has no reset endpoint.

## 🟠 HIGH

7. **Reminders stop at 0 credits.** `POST /api/schedule/reminders` returns 402 and the due reminder never arrives.
8. **Memory doesn't save natural phrasing.** For "favourite color blue hai, yaad rakhna", the AI replied
   "yaad rakhungi" but nothing was saved. `REMEMBER_RE` in `backend/src/routes/chat.js` only matches when the
   keyword comes first ("yaad rakho: …") and doesn't catch "rakhna". The AI promises something that isn't true.
9. **Image prompt enrichment is broken** (`backend/src/services/images.js:76`):
   - Any short prompt with robot/game/app/web/ai/tech gets code-editor scenery appended.
     "a cute robot waving, anime style" came out as a robot in front of a code monitor.
   - Every other short prompt gets "no people, no faces" appended, so "a girl smiling" can never work.
10. **Tool credit costs aren't enforced in chat.** Image Generator costs 20 credits in the catalog, but from
    chat it only took 2. Pro users still see `creditsCharged: 8` (cosmetic).
11. **Rate limit after about 6 AI calls (Groq TPM).** The huge system prompt hits the tokens-per-minute limit fast,
    and tools then fail with 429. The local `.env` has no `AI_FALLBACK_MODELS`.
12. **Voice is non-functional on this config.** `/health` reports `voice: unavailable`, `/api/voice/synth`
    returns 503 and realtime returns 503, because the Groq key has no TTS or realtime access.
13. **"Owner voice lock" is not real security.** Without `SPEECHBRAIN_URL` (missing locally and in
    `render.yaml`), it uses a mock DSP check based on loudness and pitch. The UI sells it as "Aira only obeys
    your voice".

## 🟡 MEDIUM

14. **Pricing mismatch.** The landing page says "100 credits on sign-up — top up any time". The backend gives
    50 and there is no top-up. `/api/user/plans` lists the free "Starter" plan at `pricePkr: 6000`.
15. **No payment path in production.** `/api/user/upgrade` is refused in production, and manual billing is
    off (`/api/billing/request` returns 503). Pro cannot be bought.
16. **Wrong Desktop pairing instructions.** The UI says `cd desktop-agent → npm run dev:agent`, but
    `desktop-agent/package.json` has no `dev:agent` script, so it fails with "Missing script". Inside that folder
    it should be `npm run dev`. The message also ends with a double period: "try again..".
17. **Schedule chip is wrong.** A task due in 4 minutes shows "Reminds tomorrow" (`SCHEDULE_CHIP.soon`,
    `src/Nexora.jsx:508`). The chip is only recalculated on refresh.
18. **Image generation is an open proxy.** `GET /api/images/generate` has no auth and no rate limit, so anyone
    can use your server to generate Pollinations images.
19. **PDF Reader / YouTube Notes over-promise.** They can't read a PDF or a YouTube URL; they ask the user to
    paste the text. (Already noted in NEXT_STEPS P0-1.)
20. **`/api/desktop/intent` makes an AI call first,** even when the agent is offline. Tokens are wasted and the
    user still gets an error.
21. **Open demo auth in dev.** With `NODE_ENV=development`, a login with any password signs straight into an
    existing account. Production forces this off, but any deploy without `NODE_ENV=production` (for example
    a self-host or Docker run without that env) is an auth bypass.
22. **Google sign-in doesn't work.** `VITE_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID` are empty, so the button
    only shows "coming soon".
23. **The "Girlfriend — Flirty, teasing & romantic" persona** conflicts with the "Nexora is all-ages" policy
    in the system prompt.

## 🟢 LOW

24. **Flaky backend test:** 1 failure in 5 runs (did not reproduce; identify it with `node --test --test-reporter=spec`).
25. **Footer social links** (WhatsApp, Email, GitHub, YouTube, X) all point to `href="#"`, so they're dead.
26. **Onboarding asks for the name again** even though it was entered at sign-up.
27. **The "Register voice" popup reappears in chat** right after the user chose "Skip for now" in onboarding.
28. **The mic chip stays on "starting"** (in automation, with no mic permission). Check it manually in a
    real browser.
29. **`/api/desktop/health` returns 502** when the agent is offline (503 would be more accurate).
30. **Quota response is contradictory:** `unlimited: true` alongside `limit: 100000`.
31. **Vercel Edge function:** the user's name is never sent (`userName` is unused), and the Edge runtime is
    deprecated (move to the Node runtime).
32. **Uploaded images are public** without auth (unguessable IDs, so low risk).
33. **Bundle size:** `index.js` is 502 KB and `three.js` is 557 KB, which makes the first load slow. Code-split them.
34. **Lint:** ~45 warnings (React refs and impure calls during render, missing hook deps); `src/Nexora.jsx` is 264 KB in one file.

## ✅ Working correctly

Register, login, duplicate-email 409, JWT validation, profile update and validation, conversations CRUD,
cross-user isolation (another user's chat returns 404), chat streaming and non-streaming, Urdu replies,
the image upload type check, memory CRUD and upsert, schedule CRUD, reminder ack, the tools list, Code
Assistant, the admin-only billing review (403), password change with token rotation, the full onboarding
flow, the settings page, and the landing page (no broken images or anchors, no console errors).

---

## Fix status (same day)

**Fixed in code and verified** (backend 124/124 across 4 runs, including 10 new regression tests in
`backend/test/fixes.test.mjs`; desktop-agent 50/50; build OK; re-checked in the browser):
#2 credit pricing (now charged on reply length, so a short reply costs 1 credit) · #3 monthly refill · #4 Vercel chat
function: origin check, per-IP rate limit, 200 KB body cap, Node runtime · #5 every browser gets its own demo account ·
#6 honest "forgot password" message · #7 reminders fall back to a free template · #8 memory phrasing ·
#9 image prompt enrichment · #10 chat images cost the tool price; premium tool runs report 0 · #11 tools and
reminders use a short ~150-token prompt · #13 honest voice-lock wording · #14 pricing copy, free plan priced 0 ·
#16 desktop setup steps and the double period · #17 "Due within 24h" label, refreshed every minute ·
#18 image endpoint rate limit · #19 renamed to Document Q&A / Video Notes · #20 /intent checks the agent first ·
#21 open auth needs an explicit AUTH_OPEN_MODE=1 · #25 dead footer links hidden · #26 name pre-filled ·
#27 voice popup respects "Skip" · #29 desktop offline returns 503 · #31 userName sent, Edge → Node · #34 7 lint warnings fixed.

**New bug found and fixed while fixing:** sign-in and sign-up caught *every* error (wrong password, duplicate
email) and logged the user in anyway, with a fake on-device session showing 999,999 credits. The offline
fallback now only runs when the backend is truly unreachable.

**Needs the owner (outside the code):** #1 deploy the Render backend and set `VITE_API_URL` on Vercel ·
#12 a voice-capable OpenAI key for TTS/realtime · #13 optional `SPEECHBRAIN_URL` for real speaker verification ·
#15 `SELLER_EASYPAISA_NUMBER` / `SELLER_JAZZCASH_NUMBER` (or a payment provider) on Render · #22 Google client
IDs · #23 product decision on the "Girlfriend" persona · #25 real social URLs in `SOCIAL_LINKS` (`src/Nexora.jsx`).

**Not changed, with reason:** #24 the flaky test did not reproduce in 8 runs (likely CPU contention from building
in parallel) · #28 mic "starting" needs a manual check in a real browser · #30 by design (loopback = unlimited,
see quota.js) · #32 upload ids are unguessable, acceptable · #33 bundle splitting needs a large refactor of
Nexora.jsx · #34 the remaining 38 warnings are React-pattern warnings inside the 264 KB Nexora.jsx.