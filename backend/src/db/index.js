import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../config.js'

let db

export function getDb() {
  if (db) return db

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  db = new DatabaseSync(config.dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      credits_remaining INTEGER NOT NULL DEFAULT 5000,
      is_premium INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      images_json TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS voice_prints (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT,
      embedding BLOB NOT NULL,
      sample_path TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    /* User-scheduled tasks ("Schedule" section). reminded_at is the nudge dedup:
       the day-before note fires once (until stamped), the day-of note fires once
       AFTER the due moment passes — one column carries both because a reminder
       stamped before due_at never satisfies the due bucket. */
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
      reminded_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

   /* Manual Easypaisa / JazzCash upgrade requests (no merchant gateway). A user
       records the transaction id after sending money to the owner's wallet; the
       owner approves or rejects it and ONLY then is the plan changed (see
       routes/billing.js). The plan is never touched by the requester - status
       starts pending and an approve is the sole path that grants premium. */
    CREATE TABLE IF NOT EXISTS billing_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan TEXT NOT NULL CHECK (plan IN ('pro', 'yearly_pro')),
      method TEXT NOT NULL CHECK (method IN ('easypaisa', 'jazzcash')),
      amount INTEGER NOT NULL,
      txn_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT,
      note TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
    CREATE INDEX IF NOT EXISTS idx_tool_runs_user ON tool_runs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_prints_user ON voice_prints(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks(user_id, due_at ASC);
    CREATE INDEX IF NOT EXISTS idx_billing_requests_user ON billing_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_requests_status ON billing_requests(status, created_at DESC);
  `)

  // Lightweight column migrations for existing databases
  const userColumns = database.prepare('PRAGMA table_info(users)').all().map((col) => col.name)
  if (!userColumns.includes('avatar')) {
    database.exec('ALTER TABLE users ADD COLUMN avatar TEXT')
  }
  if (!userColumns.includes('google_sub')) {
    database.exec('ALTER TABLE users ADD COLUMN google_sub TEXT')
  }
  if (!userColumns.includes('prefs_json')) {
    /* Companion choices (reply language, talk voice, AI name, persona, face), kept
       as one JSON blob. They used to live only in localStorage, which is per-origin
       and is cleared on logout — so someone who picked "Urdu first" silently came
       back to 'auto' on the next device and read Roman replies as a broken setting. */
    database.exec('ALTER TABLE users ADD COLUMN prefs_json TEXT')
  }
  if (!userColumns.includes('tokens_valid_after')) {
    /* Session floor for "change my password = log out every other device". A JWT is
       keyed only on the user id, so without this a token stolen before a password
       rotation stayed valid for its full 7-day life even after the owner changed it.
       Set to the rotation instant on password change; requireAuth rejects any token
       issued (iat) before it. NULL for every existing account = no floor, so the
       migration never logs anyone out on upgrade. */
    database.exec('ALTER TABLE users ADD COLUMN tokens_valid_after TEXT')
  }

  /* User-attached reference images live as /uploads paths in a JSON array so a
     text-only message and an image message can share the same table. */
  const messageColumns = database.prepare('PRAGMA table_info(messages)').all().map((col) => col.name)
  if (!messageColumns.includes('images_json')) {
    database.exec('ALTER TABLE messages ADD COLUMN images_json TEXT')
  }
  if (!messageColumns.includes('reply_to')) {
    /* "Reply" in the chat UI points a user turn at one specific earlier turn. The
       id is kept so a reloaded thread still shows the quote; the quoted text itself
       is never duplicated here — it is read back from the target message. */
    database.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT')
  }

  // Voice enrollment: CREATE TABLE IF NOT EXISTS above covers fresh and existing
  // databases alike — existing users' prints simply start accumulating on enroll.
  const voicePrintColumns = database.prepare('PRAGMA table_info(voice_prints)').all().map((col) => col.name)
  if (!voicePrintColumns.includes('label')) {
    database.exec('ALTER TABLE voice_prints ADD COLUMN label TEXT')
  }
}

export function nowIso() {
  return new Date().toISOString()
}
