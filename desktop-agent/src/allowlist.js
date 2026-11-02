import { z } from 'zod'
import { SAFE_KEYS } from './input.js'

/* ────────────────────────────────────────────────────────────────────────────
   THE ALLOWLIST is the single source of truth for what the agent can do. Every
   action is a fixed, named operation with a strict zod argument schema, the
   permission SCOPE it needs, a RISK level, and an `alwaysConfirm` flag. The one
   open-ended operation is `system.runCommand`, which is itself allowlisted, gated
   to the `system` scope and forced `alwaysConfirm` — so even it can never run
   without a human approving the exact command string.

   The language model may only ever PROPOSE `{ action, args }` that matches one
   of these definitions. Anything not in this list is rejected before a single
   syscall runs, so the model can never grant itself a permission or invent a new
   capability. High-risk / irreversible operations (send, submit, delete, write,
   organize, restart, shutdown, runCommand) force an explicit human preview→confirm
   even when the scope has already been granted.
   ──────────────────────────────────────────────────────────────────────────── */

export const SCOPES = ['browser', 'files', 'apps', 'system', 'screen', 'desktop']

/* A single coordinate is a non-negative whole pixel, generously capped so an
   absurd value fails fast. The exact on-screen bounds are enforced again at
   dispatch time against the real resolution (see input.js → assertOnScreen). */
const coord = z.number().int().min(0).max(30000)

const httpUrl = z.string().trim().url().refine(
  (u) => /^https?:\/\//i.test(u),
  { message: 'Only http(s) URLs are allowed' },
)

/* A search engine is a fixed allowlist too — we never let the model name an
   arbitrary "engine URL". */
const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
}

export const ACTIONS = [
  {
    id: 'browser.open',
    scope: 'browser',
    risk: 'low',
    alwaysConfirm: false,
    description: 'Open an approved website in the dedicated automation browser.',
    args: z.object({ url: httpUrl, waitFor: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load') }),
    preview: (a) => `Open ${a.url} in the Aira automation browser (not your personal profile).`,
  },
  {
    id: 'browser.search',
    scope: 'browser',
    risk: 'low',
    alwaysConfirm: false,
    description: 'Run a web search on an approved engine and return the result page.',
    args: z.object({ engine: z.enum(Object.keys(SEARCH_ENGINES)).default('google'), query: z.string().trim().min(1).max(300) }),
    preview: (a) => `Search ${a.engine} for: "${a.query}".`,
    buildUrl: (a) => SEARCH_ENGINES[a.engine] + encodeURIComponent(a.query),
  },
  {
    id: 'browser.snapshot',
    scope: 'browser',
    risk: 'low',
    alwaysConfirm: false,
    description: 'Extract the visible text of the current or a given page.',
    args: z.object({ url: httpUrl.optional(), maxChars: z.number().int().min(200).max(20000).default(6000) }),
    preview: (a) => `Read the visible text${a.url ? ` of ${a.url}` : ' of the current page'} (max ${a.maxChars} chars).`,
  },
  {
    id: 'browser.click',
    scope: 'browser',
    risk: 'medium',
    alwaysConfirm: false,
    description: 'Click one visible element matched by a text label or CSS selector.',
    args: z.object({ selector: z.string().trim().min(1).max(200), by: z.enum(['css', 'text']).default('css') }),
    preview: (a) => `Click the element (${a.by}) "${a.selector}".`,
  },
  {
    id: 'browser.fill',
    scope: 'browser',
    risk: 'medium',
    // Filling a form is reversible until it is SUBMITTED, so `submit:true` is
    // split into its own alwaysConfirm action below rather than hidden here.
    alwaysConfirm: false,
    description: 'Type a value into a field. Does NOT submit the form.',
    // `value` may contain personal input → flagged secret so it is redacted in
    // the preview and the audit log; only the field selector is shown.
    args: z.object({ selector: z.string().trim().min(1).max(200), value: z.string().max(2000), by: z.enum(['css', 'text', 'placeholder', 'label']).default('css'), secret: z.boolean().default(false) }),
    argsSecret: ['value'],
    preview: (a) => `Type into the field (${a.by}) "${a.selector}". ${a.secret ? '[value hidden — treated as private]' : `Value: "${a.value}"`}`,
  },
  {
    id: 'browser.submit',
    scope: 'browser',
    risk: 'high',
    // Submitting sends a message / posts a form / may be irreversible — always
    // ask a human first, even if browser access is already granted.
    alwaysConfirm: true,
    description: 'Submit the currently prepared form (sends/irreversible).',
    args: z.object({ selector: z.string().trim().min(1).max(200), by: z.enum(['css', 'text']).default('css') }),
    preview: (a) => `⚠ SUBMIT the form via button "${a.selector}". This may send a message or post data and can be irreversible.`,
  },
  {
    id: 'browser.screenshot',
    scope: 'browser',
    risk: 'low',
    alwaysConfirm: false,
    description: 'Capture a PNG of the page for debugging (saved under the agent, returned as a path).',
    args: z.object({ name: z.string().trim().max(60).regex(/^[\w-]+$/, 'Use letters, numbers, dash, underscore only').optional() }),
    preview: () => `Take a screenshot of the current page.`,
  },

  {
    id: 'apps.launch',
    scope: 'apps',
    risk: 'medium',
    alwaysConfirm: false,
    description: 'Launch an approved application by id (from the fixed executable map).',
    args: z.object({ appId: z.string().trim().min(1).max(40), targetPath: z.string().trim().max(500).optional() }),
    preview: (a) => `Launch approved app "${a.appId}"${a.targetPath ? ` opening ${a.targetPath}` : ''}.`,
  },
  {
    id: 'apps.close',
    scope: 'apps',
    risk: 'medium',
    alwaysConfirm: false,
    description: 'Close an approved application that the agent launched.',
    args: z.object({ appId: z.string().trim().min(1).max(40) }),
    preview: (a) => `Close app "${a.appId}".`,
  },

  {
    id: 'files.list',
    scope: 'files',
    risk: 'low',
    alwaysConfirm: false,
    description: 'List entries inside an approved directory (names only, non-recursive by default).',
    args: z.object({ dir: z.string().trim().min(1).max(500), recursive: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100) }),
    preview: (a) => `List files in ${a.dir}${a.recursive ? ' (recursive)' : ''}.`,
  },
  {
    id: 'files.read',
    scope: 'files',
    risk: 'low',
    alwaysConfirm: false,
    description: 'Read one text file inside an approved directory (size-capped, for "explain my build errors").',
    args: z.object({ path: z.string().trim().min(1).max(500), maxBytes: z.number().int().min(100).max(200000).default(40000) }),
    // The file BODY is private content → never shown in preview / audit.
    preview: (a) => `Read text file ${a.path} (contents kept out of the log).`,
  },
  {
    id: 'files.write',
    scope: 'files',
    risk: 'high',
    // Creating/overwriting a file can destroy work → always confirm.
    alwaysConfirm: true,
    description: 'Write a new file inside an approved directory (overwrite is refused).',
    args: z.object({ path: z.string().trim().min(1).max(500), content: z.string().max(200000) }),
    preview: (a) => `⚠ WRITE a new file ${a.path} (${a.content.length} chars). Overwriting an existing file is refused by design.`,
  },
  {
    id: 'files.organize',
    scope: 'files',
    risk: 'high',
    // Moving/renaming files is a bulk mutation → always confirm, dry-run by
    // default so the human sees the exact plan before it is applied.
    alwaysConfirm: true,
    description: 'Organize files in an approved directory (moves only; dry-run unless confirmed).',
    args: z.object({ dir: z.string().trim().min(1).max(500), strategy: z.enum(['by-extension', 'by-date', 'flatten']).default('by-extension'), apply: z.boolean().default(false) }),
    preview: (a) => `⚠ ORGANIZE ${a.dir} by ${a.strategy} — ${a.apply ? 'WILL MOVE files' : 'dry run (no changes)'}.`,
  },

  {
    id: 'system.info',
    scope: 'system',
    risk: 'low',
    alwaysConfirm: false,
    description: 'Read-only OS/session facts (platform, uptime, whether the console session is locked). Never unlocks anything.',
    args: z.object({}),
    preview: () => `Read system/session status (no changes, no unlock attempt).`,
  },
  {
    id: 'system.restart',
    scope: 'system',
    risk: 'high',
    alwaysConfirm: true,
    description: 'Restart the PC after explicit confirmation (never from ambiguous voice).',
    args: z.object({ note: z.string().trim().max(200).optional() }),
    preview: () => `⚠ RESTART the computer. Close unsaved work first — this is disruptive.`,
  },
  {
    id: 'system.shutdown',
    scope: 'system',
    risk: 'high',
    alwaysConfirm: true,
    description: 'Shut down the PC after explicit confirmation (never from ambiguous voice).',
    args: z.object({ note: z.string().trim().max(200).optional() }),
    preview: () => `⚠ SHUT DOWN the computer. Close unsaved work first — this is disruptive.`,
  },
  {
    id: 'system.runCommand',
    scope: 'system',
    risk: 'high',
    // Arbitrary command execution is the most powerful thing the agent can do, so it
    // ALWAYS shows the exact command for a human to approve — even once the system
    // scope is granted. This is the "approve each command" consent the owner chose.
    alwaysConfirm: true,
    description: 'Run a shell command (PowerShell on Windows) on this PC and return its output. Every run needs your explicit approval.',
    // The command MUST be visible in the preview — it is exactly what the human
    // approves — so it is deliberately NOT treated as a secret arg.
    args: z.object({ command: z.string().trim().min(1).max(4000), timeoutMs: z.number().int().min(1000).max(120000).default(30000) }),
    preview: (a) => `⚠ RUN COMMAND on this PC:\n${a.command}\nRuns with your user privileges. Approve only if you trust this.`,
  },

  /* ── SCREEN OBSERVATION ─────────────────────────────────────────────────── */
  {
    id: 'screen.capture',
    scope: 'screen',
    risk: 'low',
    // Read-only and scope-gated; the UI still shows a preview + Approve before it
    // runs. Nothing is written to disk unless the user explicitly sets save:true.
    alwaysConfirm: false,
    description: 'Look at the current screen so Aira can describe what she sees. Kept in memory unless you ask to save it.',
    args: z.object({
      monitor: z.enum(['primary']).default('primary'),
      maxWidth: z.number().int().min(640).max(3840).default(1920),
      save: z.boolean().default(false),
      name: z.string().trim().max(60).regex(/^[\w-]+$/, 'Use letters, numbers, dash, underscore only').optional(),
    }),
    preview: (a) => `Take a screenshot of your screen${a.save ? ' and save a copy in the agent folder' : ' (held in memory only — nothing is written to disk)'}, then describe the visible apps, elements and any errors.`,
  },

  /* ── DESKTOP CONTROL (mouse + keyboard) ─────────────────────────────────── */
  {
    id: 'desktop.move',
    scope: 'desktop',
    risk: 'medium',
    alwaysConfirm: false,
    description: 'Move the mouse pointer to a point on the screen.',
    args: z.object({ x: coord, y: coord }),
    preview: (a) => `Move the mouse pointer to (${a.x}, ${a.y}).`,
  },
  {
    id: 'desktop.click',
    scope: 'desktop',
    risk: 'medium',
    alwaysConfirm: false,
    description: 'Click at a validated screen coordinate with an allowlisted mouse button.',
    args: z.object({ x: coord, y: coord, button: z.enum(['left', 'right', 'middle']).default('left'), double: z.boolean().default(false) }),
    preview: (a) => `${a.double ? 'Double-' : ''}${a.button}-click at (${a.x}, ${a.y}).`,
  },
  {
    id: 'desktop.scroll',
    scope: 'desktop',
    risk: 'medium',
    alwaysConfirm: false,
    description: 'Scroll the pane under the pointer (optionally moving the mouse there first).',
    args: z.object({ x: coord.optional(), y: coord.optional(), direction: z.enum(['up', 'down']).default('down'), amount: z.number().int().min(1).max(25).default(3) }),
    preview: (a) => `Scroll ${a.direction} ${a.amount} notch(es)${a.x != null && a.y != null ? ` at (${a.x}, ${a.y})` : ''}.`,
  },
  {
    id: 'desktop.type',
    scope: 'desktop',
    risk: 'high',
    // Typed text lands wherever focus is and can post a message / fill a field →
    // a fresh confirmation every time, and the content is never shown or logged.
    alwaysConfirm: true,
    description: 'Type text into the focused window.',
    // eslint-disable-next-line no-control-regex
    args: z.object({ text: z.string().min(1).max(2000).regex(/^[^\u0000-\u001F\u007F]*$/, 'Control characters are not allowed — use desktop.key for Enter/Tab.') }),
    argsSecret: ['text'],
    preview: (a) => `⚠ TYPE ${a.text.length} characters into the focused window. The text is kept private (hidden here and in the audit log) and could enter data into whatever is currently focused.`,
  },
  {
    id: 'desktop.key',
    scope: 'desktop',
    risk: 'medium',
    alwaysConfirm: true,
    description: 'Press one allowlisted key combination (no Win / Ctrl+Alt+Del / UAC surface).',
    args: z.object({ combo: z.enum(Object.keys(SAFE_KEYS)) }),
    preview: (a) => `Press the “${a.combo}” key combination in the focused window.`,
  },
]

const byId = new Map(ACTIONS.map((a) => [a.id, a]))

export function getAction(id) {
  return byId.get(id) || null
}

/* Validate a proposed { action, args } against the allowlist. Returns either
   { ok:true, def, args } with parsed+defaulted args, or { ok:false, reason }.
   This is what makes the model a PROPOSER, not an authority. */
export function validateRequest(actionId, rawArgs) {
  const def = getAction(actionId)
  if (!def) return { ok: false, reason: `Action "${actionId || '(empty)'}" is not in the allowlist.` }
  const parsed = def.args.safeParse(rawArgs || {})
  if (!parsed.success) {
    return { ok: false, reason: 'Arguments failed validation.', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
  }
  return { ok: true, def, args: parsed.data }
}

/* Values for these arg keys must never appear in a preview, the plan payload
   echoed back, or the audit log (private form input, file bodies, secrets). */
export function secretArgKeys(def) {
  return def.argsSecret || []
}

export { SEARCH_ENGINES }
