// agent-core/sync/engine.ts — cloud-sync merge logic (KIEO-061).
//
// Transport-agnostic: everything runs against the minimal SyncRemote
// interface, so the app boots and works fully with sync disabled (default)
// and unit tests use an in-memory fake — no network, no Supabase project.
// The real Supabase adapter lives in client.ts (lazy optional dependency).
//
// Sync policy (documented trade-offs):
//   * Settings/permissions are LOCAL-authoritative: push overwrites remote,
//     pull only fills keys missing locally. Only allowlisted keys ever leave
//     the machine (SYNCED_SETTING_KEYS) — unknown future settings (and any
//     secret that ever lands in the table) can never sync by accident.
//   * Memory facts merge by id in BOTH directions (union). Deletes do NOT
//     propagate in v1 (no tombstones): a fact deleted locally returns on the
//     next pull if another device still holds it. Documented, not silent.
//   * Every remote write is stamped with the signed-in user_id; the server
//     RLS (supabase/schema.sql) restricts rows to their owner, and the fake
//     used in tests partitions the same way (app-layer analogue).
import type { DatabaseHandle } from '../../db/database'
import {
  createMemoryFact,
  getSetting,
  listMemoryFacts,
  listPermissions,
  setPermission,
  setSetting,
  type PermissionRow
} from '../../db/tables'
import type { PermissionLevel } from '../../shared/types'

export type SyncTable = 'synced_settings' | 'synced_permissions' | 'synced_memory_facts'

/** Minimal remote surface the engine needs (Supabase PostgREST-shaped). */
export interface SyncRemote {
  /** Signed-in user id, or null when signed out. */
  getUserId(): string | null
  /** All rows the server lets this user see (RLS already applied remotely). */
  list(table: SyncTable): Promise<Record<string, unknown>[]>
  /** Insert-or-replace rows (all must carry this user's user_id). */
  upsert(table: SyncTable, rows: Record<string, unknown>[]): Promise<void>
}

export type SyncErrorCode = 'signed-out' | 'remote-failed'

export class SyncError extends Error {
  readonly code: SyncErrorCode

  constructor(code: SyncErrorCode, message: string) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}

/** Settings keys allowed to leave the machine. Everything else stays local. */
export const SYNCED_SETTING_KEYS = [
  'tts_enabled',
  'active_llm_provider',
  'llm_models',
  'autonomous_actions'
] as const

function requireUser(remote: SyncRemote): string {
  const userId = remote.getUserId()
  if (!userId) {
    throw new SyncError('signed-out', 'Cloud sync needs sign-in first — local data is untouched.')
  }
  return userId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface PushCounts {
  settings: number
  permissions: number
  facts: number
}

export interface PullCounts {
  settings: number
  permissions: number
  facts: number
}

/** Push local → remote (local wins). Returns per-table row counts. */
export async function pushLocal(db: DatabaseHandle, remote: SyncRemote): Promise<PushCounts> {
  const userId = requireUser(remote)
  const now = Date.now()

  const settingsRows = SYNCED_SETTING_KEYS.map((key) => ({
    user_id: userId,
    key,
    value: JSON.stringify(getSetting<unknown>(db, key) ?? null),
    updated_at: now
  }))
  await remote.upsert('synced_settings', settingsRows)

  const permissions = listPermissions(db)
  await remote.upsert(
    'synced_permissions',
    permissions.map((p: PermissionRow) => ({
      user_id: userId,
      action_type: p.action_type,
      level: p.level,
      updated_at: now
    }))
  )

  const facts = listMemoryFacts(db)
  await remote.upsert(
    'synced_memory_facts',
    facts.map((f) => ({
      user_id: userId,
      id: f.id,
      fact: f.fact,
      created_at: f.created_at,
      edited_by_user: f.edited_by_user,
      updated_at: now
    }))
  )

  return { settings: settingsRows.length, permissions: permissions.length, facts: facts.length }
}

/** Pull remote → local, filling only keys/rows missing locally. */
export async function pullRemote(db: DatabaseHandle, remote: SyncRemote): Promise<PullCounts> {
  requireUser(remote)
  const counts: PullCounts = { settings: 0, permissions: 0, facts: 0 }

  for (const row of await remote.list('synced_settings')) {
    if (!isRecord(row) || typeof row['key'] !== 'string' || typeof row['value'] !== 'string') continue
    const key = row['key']
    if (!(SYNCED_SETTING_KEYS as readonly string[]).includes(key)) continue
    if (getSetting<unknown>(db, key) !== null) continue
    try {
      setSetting(db, key, JSON.parse(row['value']) as unknown)
      counts.settings += 1
    } catch {
      // Corrupt remote value: skip, never poison the local store.
    }
  }

  for (const row of await remote.list('synced_permissions')) {
    if (!isRecord(row) || typeof row['action_type'] !== 'string') continue
    if (listPermissions(db).some((p) => p.action_type === row['action_type'])) continue
    const level = row['level']
    if (level !== 'always_allow' && level !== 'ask_every_time' && level !== 'never_allow') continue
    setPermission(db, row['action_type'], level as PermissionLevel)
    counts.permissions += 1
  }

  const localFactIds = new Set(listMemoryFacts(db).map((f) => f.id))
  for (const row of await remote.list('synced_memory_facts')) {
    if (!isRecord(row) || typeof row['id'] !== 'string' || typeof row['fact'] !== 'string') continue
    if (localFactIds.has(row['id'])) continue
    createMemoryFact(db, { id: row['id'], fact: row['fact'] })
    localFactIds.add(row['id'])
    counts.facts += 1
  }

  return counts
}

export interface SyncResult {
  pushed: PushCounts
  pulled: PullCounts
}

/** Full round-trip: push local-wins first, then gap-fill pull. */
export async function syncNow(db: DatabaseHandle, remote: SyncRemote): Promise<SyncResult> {
  const pushed = await pushLocal(db, remote)
  const pulled = await pullRemote(db, remote)
  return { pushed, pulled }
}
