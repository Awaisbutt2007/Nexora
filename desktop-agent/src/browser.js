import fs from 'node:fs'
import path from 'node:path'

/* Browser automation via Playwright. Two non-negotiable rules:
   1. A DEDICATED automation profile (AGENT_BROWSER_PROFILE) is used, never the
      user's real browser profile — so no personal cookies, saved passwords,
      history or session tokens are ever read, exported or reused.
   2. Navigation is confined to http(s) and, when AGENT_ALLOWED_HOSTS is set, to
      those hosts.

   Playwright is an OPTIONAL dependency: the module lazily imports it so the agent
   (and its tests) run with the browser binary absent; browser actions then fail
   with a clear "install it" message instead of crashing the process. */

/* What "the browser is gone" looks like: a context whose window the user closed,
   whose process died, or whose error text says so out loud. */
export const isDead = (ctx) => !ctx || ctx.closed?.() === true || ctx.browser?.()?.isConnected?.() === false
const DEAD_BROWSER = /target page, context or browser has been closed|browser has been closed|target closed|connection closed/i

/**
 * The launch cache, as a factory so the state machine is testable without a real
 * browser (Playwright cannot run in CI).
 *
 * WHY THIS EXISTS: a persistent context outlives its own death. With
 * `AGENT_BROWSER=headed chromium` — the normal setup on this machine — simply
 * closing the automation window is enough, and the first version of this file
 * cached the launch promise forever without ever asking whether the thing behind
 * it still existed. Every browser action after that failed in ~25ms with
 * "Target page, context or browser has been closed", and nothing short of an agent
 * restart cleared it; a real session's audit log shows one DNS failure followed by
 * five identical instant deaths. So the cache asks `isDead` before reusing a
 * context, listens for its `close` event, shares one in-flight launch, and lets a
 * caller `forget()` a context that died between the check and the call.
 */
export function makeContextCache({ launch }) {
  let value = null
  let pending = null

  async function get(opts) {
    const hosts = opts.allowedHosts || []
    if (value && !isDead(value)) {
      /* Refresh the host list on every use: a host granted at runtime must apply
         to the browser that is already open, not only to the next launch. */
      value.__allowedHosts = hosts
      return value
    }
    value = null
    if (!pending) {
      pending = launch(opts)
        .then((ctx) => {
          pending = null
          if (isDead(ctx)) throw new Error('The automation browser closed while it was starting.')
          value = ctx
          try { ctx.on?.('close', () => { if (value === ctx) value = null }) } catch { /* engine without events */ }
          return ctx
        })
        .catch((err) => { pending = null; throw err })
    }
    const ctx = await pending
    ctx.__allowedHosts = hosts
    return ctx
  }

  return {
    get,
    /* Drop a context we just discovered is dead — and only if it is still THE
       cached one, so a slow revive can never clobber a fresher launch. */
    forget: (ctx) => { if (value === ctx) value = null },
    isAlive: () => Boolean(value) && !isDead(value),
    async close() {
      const ctx = value
      value = null
      pending = null
      if (!ctx) return
      try { await ctx.close() } catch { /* already gone */ }
    },
  }
}

async function launchPersistent({ profileDir, headless }) {
  const pw = await loadPlaywright()
  fs.mkdirSync(profileDir, { recursive: true })
  return pw.chromium.launchPersistentContext(profileDir, {
    headless,
    args: ['--no-default-browser-check', '--no-first-run'],
  })
}

/* One persistent context for the session → the automation "persona" (its own
   profile dir) survives between actions, exactly like a real logged-out browser
   the user can watch. */
const cache = makeContextCache({ launch: launchPersistent })

async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    const e = new Error('Playwright is not installed. Run `npm run browsers:install` inside desktop-agent/ to enable browser automation.')
    e.code = 'PLAYWRIGHT_MISSING'
    throw e
  }
}

function assertHostAllowed(url, allowedHosts) {
  const u = new URL(url)
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed.')
  if (allowedHosts && allowedHosts.length && !allowedHosts.includes(u.hostname.toLowerCase())) {
    throw new Error(`Host "${u.hostname}" is not in the approved browser host list.`)
  }
  return u
}

async function openPage(ctx, url, { waitFor = 'load', signal } = {}, opts = {}) {
  assertHostAllowed(url, ctx.__allowedHosts)
  if (signal?.aborted) throw signal.reason || new Error('cancelled')
  let page
  try {
    page = await ctx.newPage()
  } catch (err) {
    /* The `close` event is async, so a context can still die in the gap between
       the liveness check and this call. Revive once, then let the real error stand. */
    if (!DEAD_BROWSER.test(String(err?.message || ''))) throw err
    cache.forget(ctx)
    page = await (await cache.get(opts)).newPage()
  }
  page.setDefaultTimeout(30000)
  try {
    await page.goto(url, { waitUntil: waitFor })
  } catch (err) {
    /* A page that failed to navigate is an error page; keeping it around would
       make every follow-up snapshot/click act on it instead of a real document. */
    await page.close().catch(() => {})
    throw readableNavError(err, url)
  }
  if (signal?.aborted) { await page.close(); throw signal.reason || new Error('cancelled') }
  return page
}

/* Playwright's navigation errors are stack fragments with ANSI escapes in them,
   and they are what the user actually reads: `execute()` puts the message into
   `reason`, which the chat echoes into the reply. The cases that really happen on
   this machine get a sentence instead. */
function readableNavError(err, url) {
  const raw = String(err?.message || err || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0]
  let host = 'the site'
  try { host = new URL(url).hostname } catch { /* keep the generic noun */ }
  if (/ERR_NAME_NOT_RESOLVED/i.test(raw)) return new Error(`${host} did not resolve — this machine has no route to it (check the connection or a DNS block).`)
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/i.test(raw)) return new Error(`${host} refused the connection.`)
  if (/ERR_CERT/i.test(raw)) return new Error(`${host} presented an invalid TLS certificate.`)
  if (/timeout/i.test(raw)) return new Error(`${host} did not finish loading within 30 seconds.`)
  return new Error(raw || 'The browser failed to open the page.')
}

async function activePage(ctx) {
  const pages = ctx.pages()
  return pages[pages.length - 1] || null
}

/* ---- public action handlers (each gets (args, signal)) ---- */

export async function open(args, opts) {
  const ctx = await getContextFor(opts)
  const page = await openPage(ctx, args.url, { waitFor: args.waitFor, signal: opts.signal }, opts)
  // leave the page open for follow-up snapshot/click actions
  return { url: page.url(), title: await page.title(), status: 'opened' }
}

export async function search(args, opts) {
  const ctx = await getContextFor(opts)
  const engineBase = { google: 'https://www.google.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=', bing: 'https://www.bing.com/search?q=' }[args.engine]
  const engineUrl = `${engineBase}${encodeURIComponent(args.query)}`
  const page = await openPage(ctx, engineUrl, { signal: opts.signal }, opts)
  return { engine: args.engine, query: args.query, url: page.url(), title: await page.title() }
}

export async function snapshot(args, opts) {
  const ctx = await getContextFor(opts)
  let page
  if (args.url) page = await openPage(ctx, args.url, { signal: opts.signal }, opts)
  else page = await activePage(ctx)
  if (!page) throw new Error('No page is open. Call browser.open or browser.search first.')
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '')
  return { url: page.url(), title: await page.title(), text: bodyText.slice(0, args.maxChars), truncated: bodyText.length > args.maxChars }
}

export async function click(args, opts) {
  const ctx = await getContextFor(opts)
  const page = await activePage(ctx)
  if (!page) throw new Error('No page is open.')
  const locator = args.by === 'text' ? page.getByText(args.selector).first() : page.locator(args.selector).first()
  await locator.waitFor({ state: 'visible', timeout: 15000 })
  await locator.click()
  return { clicked: args.selector, by: args.by, url: page.url() }
}

export async function fill(args, opts) {
  const ctx = await getContextFor(opts)
  const page = await activePage(ctx)
  if (!page) throw new Error('No page is open.')
  let locator
  if (args.by === 'label') locator = page.getByLabel(args.selector).first()
  else if (args.by === 'placeholder') locator = page.getByPlaceholder(args.selector).first()
  else if (args.by === 'text') locator = page.getByText(args.selector).first()
  else locator = page.locator(args.selector).first()
  await locator.waitFor({ state: 'visible', timeout: 15000 })
  await locator.fill(args.value)
  // NOTE: value is never returned (it may be private) — confirm that invariant.
  return { filled: args.selector, by: args.by }
}

export async function submit(args, opts) {
  const ctx = await getContextFor(opts)
  const page = await activePage(ctx)
  if (!page) throw new Error('No page is open.')
  const locator = args.by === 'text' ? page.getByText(args.selector).first() : page.locator(args.selector).first()
  await locator.waitFor({ state: 'visible', timeout: 15000 })
  await locator.click()
  return { submitted: true, url: page.url(), note: 'Form submitted — this action was irreversible and was explicitly confirmed.' }
}

export async function screenshot(args, opts) {
  const ctx = await getContextFor(opts)
  const page = await activePage(ctx)
  if (!page) throw new Error('No page is open.')
  fs.mkdirSync(opts.screenshotDir, { recursive: true })
  const name = (args.name || `shot-${Date.now()}`).replace(/[^\w-]/g, '')
  const file = path.join(opts.screenshotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return { saved: file, url: page.url() }
}

/* ---- lifecycle ---- */

async function getContextFor(opts) {
  return cache.get(opts)
}

/* True only while a LIVE context exists — `isAvailable()` once reported "a promise
 * was cached once", which stayed true for the dead browser it was describing. */
export function isAvailable() {
  return cache.isAlive()
}

export async function close() {
  await cache.close()
}
