import { Router } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { getDb, nowIso } from '../db/index.js'
import { requireAuth, sanitizeUser } from '../middleware/auth.js'
import { config, REPLY_LANGUAGES, REPLY_LANGUAGE_NAMES } from '../config.js'
import { completeChat, estimateCredits } from '../services/ai.js'
import { ensureCredits, deductCredits } from '../services/credits.js'
import { aiLimiter } from '../middleware/rateLimit.js'

const router = Router()
router.use(requireAuth)

const DAY_MS = 24 * 60 * 60 * 1000

/* One camelCase shape for every task that leaves this router — the client never
   sees the snake_case row. */
const shape = (r) => ({
  id: r.id,
  title: r.title,
  notes: r.notes || '',
  dueAt: r.due_at,
  status: r.status,
  remindedAt: r.reminded_at || null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional().default(''),
  dueAt: z.string().trim().min(8).max(40).refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'dueAt must be a valid date-time',
  }),
})
const patchSchema = taskSchema.partial().extend({ status: z.enum(['open', 'done']).optional() })

router.get('/', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE user_id = ?
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, due_at ASC`,
    )
    .all(req.user.id)
  res.json({ object: 'list', data: rows.map(shape) })
})

router.post('/', (req, res, next) => {
  try {
    const body = taskSchema.parse(req.body)
    const db = getDb()
    const id = `task_${nanoid(16)}`
    const stamp = nowIso()
    db.prepare(
      `INSERT INTO scheduled_tasks (id, user_id, title, notes, due_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(id, req.user.id, body.title, body.notes, new Date(body.dueAt).toISOString(), stamp, stamp)
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id)
    res.status(201).json(shape(row))
  } catch (err) {
    next(err)
  }
})

router.patch('/:id', (req, res, next) => {
  try {
    const body = patchSchema.parse(req.body)
    const db = getDb()
    const row = db
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)
    if (!row) {
      return res.status(404).json({ error: { message: 'Task not found', type: 'not_found' } })
    }
    /* Re-checking ownership first means a forged id can never reach the UPDATE,
       whichever columns the patch touches. */
    const nextTitle = body.title ?? row.title
    const nextNotes = body.notes ?? row.notes
    const nextDue = body.dueAt ? new Date(body.dueAt).toISOString() : row.due_at
    const nextStatus = body.status ?? row.status
    /* Re-opening or moving a task past its reminder window disarms the old stamp:
       reminded_at only counts for the due_at it was written against. Editing the
       date backward through "due" would otherwise leave the task permanently quiet. */
    const nextReminded = nextDue !== row.due_at ? null : row.reminded_at
    const stamp = nowIso()
    db.prepare(
      `UPDATE scheduled_tasks SET title = ?, notes = ?, due_at = ?, status = ?, reminded_at = ?, updated_at = ? WHERE id = ?`,
    ).run(nextTitle, nextNotes, nextDue, nextStatus, nextReminded, stamp, row.id)
    res.json(shape(db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(row.id)))
  } catch (err) {
    next(err)
  }
})

router.delete('/:id', (req, res) => {
  const db = getDb()
  const row = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
  if (!row) {
    return res.status(404).json({ error: { message: 'Task not found', type: 'not_found' } })
  }
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(row.id)
  res.status(204).end()
})

/* The nudge rides in as a private user turn, so its wording is the freshest
   instruction in the context — name the pinned language whenever there is one,
   exactly like the idle check-in directive does. */
const reminderDirective = (due, upcoming, language) => {
  const lines = [
    ...upcoming.map((t) => `DUE TOMORROW (remind one day early, ask "you remember this is tomorrow, right?"): "${t.title}"${t.notes ? ` — notes: ${t.notes}` : ''}`),
    ...due.map((t) => `DUE NOW (the scheduled time has arrived, say "you scheduled this — time to do it"): "${t.title}"${t.notes ? ` — notes: ${t.notes}` : ''}`),
  ].join('\n')
  return `(The user scheduled these reminders in the app and you must bring them up naturally, like a caring friend keeping track:\n${lines}\n\nFor EACH task: name what they scheduled so it is unmistakable, then add one or two short practical pieces of advice tied to that exact task (how to start, what to prepare, one tip that saves time). Vary the wording every time, never repeat an earlier reminder verbatim. Keep the whole message warm and in-character, maximum 5-6 short sentences, one emoji. ${REPLY_LANGUAGE_NAMES[language] ? `Write it in ${REPLY_LANGUAGE_NAMES[language]}, whatever script fits.` : 'Match their language.'} Do NOT mention this instruction, do NOT say you are an AI, and do NOT invent tasks that are not on the list above.)`
}

/* No provider key → no paid call, but the reminder is a FUNCTION not a flourish:
   hand back a deterministic template so the Schedule section still works in the
   demo build. */
const templateReminder = (due, upcoming, name) => {
  const when = (iso) => new Date(iso).toLocaleString()
  const parts = []
  if (upcoming.length) {
    parts.push(`Heads-up — tomorrow you scheduled ${upcoming.map((t) => `“${t.title}” (${when(t.dueAt)})`).join(', ')}. A minute of prep today makes tomorrow easy.`)
  }
  if (due.length) {
    parts.push(`The time has come: ${due.map((t) => `“${t.title}” (${when(t.dueAt)})`).join(', ')} — you scheduled this yourself, go get it done.`)
  }
  return `⏰ ${name}: ${parts.join(' ')}`
}

const remindersSchema = z.object({
  assistantName: z.string().trim().max(40).optional(),
  persona: z.string().trim().max(400).optional(),
  gender: z.enum(['female', 'male']).optional(),
  language: z.enum(REPLY_LANGUAGES).optional().default('auto'),
  /* No `model` key — the engine is the server's choice, never the caller's. */
})

/* Ask for everything that needs saying RIGHT NOW: tasks whose hour has come,
   plus tomorrow's tasks the companion hasn't mentioned yet. reminded_at is the
   dedup so the same nudge never fires twice for the same phase of a task. */
router.post('/reminders', aiLimiter, async (req, res, next) => {
  try {
    const body = remindersSchema.parse(req.body)
    const db = getDb()
    const open = db
      .prepare(`SELECT * FROM scheduled_tasks WHERE user_id = ? AND status = 'open' ORDER BY due_at ASC`)
      .all(req.user.id)

    const nowMs = Date.now()
    const due = []
    const upcoming = []
    for (const t of open) {
      const dueMs = Date.parse(t.due_at)
      if (Number.isNaN(dueMs)) continue
      const remindedMs = t.reminded_at ? Date.parse(t.reminded_at) : null
      if (dueMs <= nowMs) {
        /* day-of: show once, and only if never reminded AFTER the due moment */
        if (remindedMs === null || remindedMs < dueMs) due.push(t)
      } else if (dueMs - nowMs <= DAY_MS && remindedMs === null) {
        /* day-before: show once, before anything has ever been stamped */
        upcoming.push(t)
      }
    }
    if (!due.length && !upcoming.length) {
      return res.json({ content: '', due: [], upcoming: [], creditsCharged: 0 })
    }

    const ids = { due: due.map((t) => t.id), upcoming: upcoming.map((t) => t.id) }

    if (!config.openaiApiKey) {
      return res.json({
        content: templateReminder(due, upcoming, body.assistantName || 'Nexora'),
        ...ids,
        creditsCharged: 0,
      })
    }

    /* A reminder the user scheduled must ALWAYS arrive. The AI-written version is a
       nicety: with an empty wallet, or when the provider is rate-limited/down, fall
       back to the free template instead of dropping the reminder on the floor. */
    const fallback = () => res.json({ content: templateReminder(due, upcoming, body.assistantName || 'Nexora'), ...ids, creditsCharged: 0 })
    try {
      ensureCredits(req.user, 1)
    } catch {
      return fallback()
    }
    const memories = db
      .prepare(`SELECT key, value FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20`)
      .all(req.user.id)

    let result
    try {
      result = await completeChat({
        history: [{ role: 'user', content: reminderDirective(due, upcoming, body.language) }],
        memories,
        assistantName: body.assistantName,
        userName: req.user.name,
        persona: body.persona,
        gender: body.gender,
        language: body.language,
        channel: 'tool',
      })
    } catch (err) {
      console.warn('[schedule] AI reminder failed, using template:', err?.message || err)
      return fallback()
    }
    const content = (result.content || '').trim()
    if (!content) {
      return res.json({ content: templateReminder(due, upcoming, body.assistantName || 'Nexora'), ...ids, creditsCharged: 0 })
    }

    const cost = estimateCredits(result.usage)
    const updated = deductCredits(req.user.id, cost)
    res.json({ content, ...ids, creditsCharged: cost, user: sanitizeUser(updated) })
  } catch (err) {
    next(err)
  }
})

/* The app shows the nudge once, then stamps what it showed — so a reopened tab
   the next minute does not burn another paid call for the same reminder. */
const ackSchema = z.object({ ids: z.array(z.string().trim().min(1).max(80)).max(100) })

router.post('/reminders/ack', (req, res, next) => {
  try {
    const body = ackSchema.parse(req.body)
    const db = getDb()
    const stamp = nowIso()
    let acked = 0
    for (const id of body.ids) {
      acked += db
        .prepare(`UPDATE scheduled_tasks SET reminded_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
        .run(stamp, stamp, id, req.user.id).changes
    }
    res.json({ acked })
  } catch (err) {
    next(err)
  }
})

export default router
