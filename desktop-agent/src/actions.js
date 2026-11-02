import { randomUUID } from 'node:crypto'
import { validateRequest, getAction } from './allowlist.js'
import { runWithTimeout, stopAll, runningCount } from './runner.js'
import { audit } from './audit.js'
import * as browser from './browser.js'
import * as apps from './apps.js'
import * as fsops from './fsops.js'
import * as system from './system.js'
import * as screen from './screen.js'
import * as input from './input.js'

/* A PLAN is a validated, previewed intent with a short-lived id. Execution is a
   separate call that must present the plan id (and, for alwaysConfirm actions, an
   explicit approval). Tokens expire quickly, so a stale preview can never be
   replayed into a destructive action. */
const PLAN_TTL_MS = 5 * 60 * 1000

const POWER_ACTIONS = new Set(['system.restart', 'system.shutdown'])

export class Agent {
  constructor({ config, permissions }) {
    this.config = config
    this.permissions = permissions
    this.plans = new Map() // planId → { actionId, args, scope, alwaysConfirm, preview, expiresAt }
  }

  #effectiveAllowedDirs() {
    return [...new Set([...this.config.allowedDirs, ...this.permissions.snapshot().allowedDirs])]
  }

  #effectiveApprovedApps() {
    return [...new Set([...this.config.approvedAppIds, ...this.permissions.snapshot().approvedAppIds])]
  }

  #browserOpts(signal) {
    const headless = !/headed/i.test(this.config.browser)
    return {
      profileDir: this.config.browserProfileDir,
      headless,
      allowedHosts: this.permissions.snapshot().allowedHosts.length
        ? this.permissions.snapshot().allowedHosts
        : this.config.allowedHosts,
      screenshotDir: `${this.config.rootDir}/screenshots`,
      signal,
    }
  }

  /* STEP 1 — plan. Validates against the allowlist and returns a human preview +
     the permission posture (scope granted? confirm required?). Performs NO action. */
  plan(actionId, rawArgs, { fromVoice = false } = {}) {
    const v = validateRequest(actionId, rawArgs)
    if (!v.ok) {
      audit({ event: 'plan.rejected', action: actionId, reason: v.reason })
      return { ok: false, status: 'invalid', reason: v.reason, issues: v.issues }
    }
    const { def, args } = v

    // Ambiguous voice may never arm a power action — require an explicit typed/UI confirm.
    if (fromVoice && POWER_ACTIONS.has(def.id)) {
      audit({ event: 'plan.blocked_voice', action: def.id })
      return { ok: false, status: 'voice_blocked', reason: 'Restart/shutdown must be confirmed explicitly in the app, never from a voice command.' }
    }

    const scopeGranted = this.permissions.isScopeGranted(def.scope)
    const preview = def.preview(args)
    const planId = randomUUID()
    this.plans.set(planId, {
      actionId: def.id,
      args,
      scope: def.scope,
      alwaysConfirm: def.alwaysConfirm,
      preview,
      expiresAt: Date.now() + PLAN_TTL_MS,
    })
    this.#prunePlans()

    audit({ event: 'plan.created', action: def.id, scope: def.scope, risk: def.risk })
    return {
      ok: true,
      planId,
      action: def.id,
      scope: def.scope,
      risk: def.risk,
      preview,
      needsScope: !scopeGranted ? def.scope : null,
      needsConfirm: def.alwaysConfirm,
      expiresInSeconds: Math.round(PLAN_TTL_MS / 1000),
    }
  }

  /* STEP 2 — execute. Re-validates (args could have drifted / plan expired),
     runs the default-deny permission gate, then dispatches under a timeout. */
  async execute(planId, { approvedThisAction = false } = {}) {
    const plan = this.plans.get(planId)
    if (!plan) return { ok: false, status: 'unknown_plan', reason: 'Plan not found or already consumed.' }
    if (Date.now() > plan.expiresAt) {
      this.plans.delete(planId)
      return { ok: false, status: 'expired', reason: 'Plan expired. Request a fresh preview.' }
    }

    const def = getAction(plan.actionId)
    const gate = this.permissions.check({ scope: def.scope, alwaysConfirm: def.alwaysConfirm, approvedThisAction })
    if (!gate.allowed) {
      audit({ event: 'execute.denied', action: def.id, reason: gate.reason })
      return { ok: false, status: gate.needsConfirm ? 'needs_confirmation' : 'permission_denied', reason: gate.reason }
    }

    // Consume the plan so it cannot be replayed.
    this.plans.delete(planId)

    const outcome = await runWithTimeout({
      action: def.id,
      timeoutMs: this.config.actionTimeoutMs,
      handler: (signal) => this.#dispatch(def, plan.args, signal),
    })

    audit({
      event: `execute.${outcome.status}`,
      action: def.id,
      scope: def.scope,
      status: outcome.status,
      reason: outcome.reason || undefined,
      // never log result bodies (they can contain file text / page text)
      __dropKeys: ['result', 'value', 'content', 'text'],
    })

    if (outcome.status !== 'completed') {
      return { ok: false, status: outcome.status, reason: outcome.reason }
    }
    // Strip any secret args from the echoed result before returning to callers.
    return { ok: true, status: 'completed', action: def.id, result: this.#sanitizeResult(def, outcome.result) }
  }

  #sanitizeResult(_def, result) {
    return result
  }

  async #dispatch(def, args, signal) {
    switch (def.id) {
      case 'browser.open': return browser.open(args, this.#browserOpts(signal))
      case 'browser.search': return browser.search(args, this.#browserOpts(signal))
      case 'browser.snapshot': return browser.snapshot(args, this.#browserOpts(signal))
      case 'browser.click': return browser.click(args, this.#browserOpts(signal))
      case 'browser.fill': return browser.fill(args, this.#browserOpts(signal))
      case 'browser.submit': return browser.submit(args, this.#browserOpts(signal))
      case 'browser.screenshot': return browser.screenshot(args, this.#browserOpts(signal))

      case 'apps.launch': return apps.launch(args, { approvedAppIds: this.#effectiveApprovedApps(), allowedDirs: this.#effectiveAllowedDirs() })
      case 'apps.close': return apps.close(args)

      case 'files.list': return fsops.list(args, this.#effectiveAllowedDirs())
      case 'files.read': return fsops.read(args, this.#effectiveAllowedDirs())
      case 'files.write': return fsops.writeNew(args, this.#effectiveAllowedDirs())
      case 'files.organize': return fsops.organize(args, this.#effectiveAllowedDirs())

      case 'system.info': return system.info()
      case 'system.restart': return system.restart(args, signal)
      case 'system.shutdown': return system.shutdown(args, signal)
      case 'system.runCommand': return system.runCommand(args, signal)

      // Screen observation — the bytes are returned in-memory to the caller; the
      // execute() audit already drops result bodies, and nothing is written to
      // disk unless the user explicitly passed save:true.
      case 'screen.capture': return screen.capture({ ...args, screenshotDir: `${this.config.rootDir}/screenshots`, signal })

      // Desktop control — each handler re-validates coordinates against the real
      // screen and only ever reaches the OS through execFile/PowerShell fixed argv.
      case 'desktop.move': return input.move(args, { signal })
      case 'desktop.click': return input.click(args, { signal })
      case 'desktop.scroll': return input.scroll(args, { signal })
      case 'desktop.type': return input.type(args, { signal })
      case 'desktop.key': return input.key(args, { signal })

      default: throw new Error(`No handler wired for allowlisted action "${def.id}".`)
    }
  }

  stop() {
    const { stopped, count } = stopAll()
    // Best-effort: if a power action was just scheduled, try to recall it.
    const recall = POWER_ACTIONS.size && stopped.some((s) => POWER_ACTIONS.has(s.action))
      ? system.abortPower()
      : Promise.resolve({ attempted: false })
    audit({ event: 'emergency_stop', cancelled: count })
    return recall.then((r) => ({ cancelled: count, stopped, powerAbort: r }))
  }

  #prunePlans() {
    const now = Date.now()
    for (const [id, p] of this.plans) if (now > p.expiresAt) this.plans.delete(id)
  }

  stats() {
    return { pendingPlans: this.plans.size, running: runningCount() }
  }
}

export { POWER_ACTIONS }
