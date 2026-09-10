// db/database.ts — connection management + migration runner (KIEO-002).
//
// Usage:
//   import { initDatabase } from '../db/database'
//   initDatabase(app.getPath('userData')) // once, in electron/main.ts onReady
//
// The database file is created on first launch at the per-OS app-data path
// (<userData>/kieo.sqlite). WAL mode + foreign-key enforcement are on.
import Database from 'better-sqlite3'
import type { Database as DatabaseHandle } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MIGRATIONS } from './migrations'

export type { DatabaseHandle }

const DB_FILENAME = 'kieo.sqlite'

// Open handles, keyed by resolved path. The entry created by initDatabase()
// is additionally reachable as the default via getDatabase().
const instances = new Map<string, DatabaseHandle>()
let defaultPath: string | null = null

function openAt(resolvedPath: string): DatabaseHandle {
  const existing = instances.get(resolvedPath)
  if (existing) return existing
  mkdirSync(dirname(resolvedPath), { recursive: true })
  const db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  instances.set(resolvedPath, db)
  return db
}

/** Open (creating if needed) the database at a path. */
export function getDatabase(dbPath?: string): DatabaseHandle {
  if (dbPath) return openAt(dbPath)
  if (!defaultPath) {
    throw new Error(
      'No database initialized — call initDatabase(userDataDir) first (electron/main.ts).'
    )
  }
  const db = instances.get(defaultPath)
  if (!db) throw new Error('Default database handle was closed.')
  return db
}

/**
 * Apply pending migrations in version order. Idempotent: applied versions are
 * recorded in `_migrations` and skipped, so this is safe on every launch.
 * Returns the versions applied by this call (empty when already current).
 */
export function runMigrations(db?: DatabaseHandle): number[] {
  const target = db ?? getDatabase()
  target.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`
  )
  const appliedRows = target
    .prepare('SELECT version FROM _migrations')
    .all() as Array<{ version: number }>
  const applied = new Set(appliedRows.map((r) => r.version))
  const appliedNow: number[] = []

  const applyAll = target.transaction(() => {
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      target.exec(m.sql)
      target
        .prepare(
          'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)'
        )
        .run(m.version, m.name, Date.now())
      appliedNow.push(m.version)
    }
  })
  applyAll()

  return appliedNow
}

/**
 * Initialize the app database inside the per-OS app-data directory and run
 * pending migrations. Call once at startup; safe to call again (no-op when
 * current).
 */
export function initDatabase(userDataDir: string): DatabaseHandle {
  const dbPath = join(userDataDir, DB_FILENAME)
  const db = openAt(dbPath)
  defaultPath = dbPath
  runMigrations(db)
  return db
}

/** Close one handle (by path, or the default) or every handle. */
export function closeDatabase(dbPath?: string): void {
  if (dbPath) {
    instances.get(dbPath)?.close()
    instances.delete(dbPath)
    if (defaultPath === dbPath) defaultPath = null
    return
  }
  for (const db of instances.values()) db.close()
  instances.clear()
  defaultPath = null
}
