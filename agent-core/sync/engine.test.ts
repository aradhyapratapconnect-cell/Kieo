// agent-core/sync/engine.test.ts — KIEO-061 merge coverage (pnpm test).
//
// In-memory fake remote partitioned by user_id (the app-layer analogue of
// the server RLS in supabase/schema.sql): proves user scoping, local-wins
// push, gap-fill pull, and fact-union merge without any network.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { createMemoryFact, getSetting, listMemoryFacts, listPermissions, setPermission, setSetting } from '../../db/tables'
import { pullRemote, pushLocal, syncNow, SyncError, type SyncRemote, type SyncTable } from './engine'

/** Fake server: per-user partitioned tables, like RLS would enforce. */
function fakeRemote(userId: string | null): SyncRemote & { tables: Record<SyncTable, Record<string, unknown>[]> } {
  const tables: Record<SyncTable, Record<string, unknown>[]> = {
    synced_settings: [],
    synced_permissions: [],
    synced_memory_facts: []
  }
  // All fakes share one "server" per user — keyed transports share storage.
  const servers = fakeRemote.servers
  const server = (servers[userId ?? 'signed-out'] ??= {
    synced_settings: [],
    synced_permissions: [],
    synced_memory_facts: []
  })
  return {
    tables: server,
    getUserId: () => userId,
    list: async (table) => server[table].map((r) => ({ ...r })),
    upsert: async (table, rows) => {
      for (const row of rows) {
        // Server-side ownership check (what RLS does for real).
        if (row['user_id'] !== userId) throw new Error('cross-user write blocked')
        const keyOf = (r: Record<string, unknown>): string =>
          String(r['key'] ?? r['action_type'] ?? r['id'])
        const idx = server[table].findIndex((r) => keyOf(r) === keyOf(row))
        if (idx === -1) server[table].push({ ...row })
        else server[table][idx] = { ...row }
      }
    }
  }
}
fakeRemote.servers = {} as Record<string, Record<SyncTable, Record<string, unknown>[]>>;

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  fakeRemote.servers = {}
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-sync-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-061 sync engine', () => {
  it('refuses to touch anything while signed out (AC1: local untouched)', async () => {
    const db = tempDb()
    const remote = fakeRemote(null)
    await expect(pushLocal(db, remote)).rejects.toMatchObject({ name: 'SyncError', code: 'signed-out' })
    await expect(pullRemote(db, remote)).rejects.toBeInstanceOf(SyncError)
    expect(remote.tables.synced_settings).toHaveLength(0)
  })

  it('pushes allowlisted settings + permissions + facts with the user stamp', async () => {
    const db = tempDb()
    setSetting(db, 'tts_enabled', false)
    setPermission(db, 'delete_file', 'never_allow')
    createMemoryFact(db, { fact: 'User uses pnpm' })
    // A non-allowlisted key must never leave the machine.
    setSetting(db, 'workspace_root', '/secret/path')

    const remote = fakeRemote('user-a')
    const pushed = await pushLocal(db, remote)
    expect(pushed.settings).toBe(4)
    expect(pushed.permissions).toBeGreaterThan(0)
    expect(pushed.facts).toBe(1)

    const keys = remote.tables.synced_settings.map((r) => r['key'])
    expect(keys).not.toContain('workspace_root')
    expect(remote.tables.synced_settings.every((r) => r['user_id'] === 'user-a')).toBe(true)
    expect(remote.tables.synced_memory_facts[0]).toMatchObject({
      user_id: 'user-a',
      fact: 'User uses pnpm'
    })
  })

  it('pull fills gaps only — local wins on conflict', async () => {
    const db = tempDb()
    setSetting(db, 'tts_enabled', false)
    const remote = fakeRemote('user-a')
    remote.tables.synced_settings.push(
      { user_id: 'user-a', key: 'tts_enabled', value: 'true', updated_at: 2 },
      { user_id: 'user-a', key: 'active_llm_provider', value: '"groq"', updated_at: 2 }
    )
    const pulled = await pullRemote(db, remote)
    expect(pulled.settings).toBe(1)
    expect(getSetting(db, 'tts_enabled')).toBe(false)
    expect(getSetting(db, 'active_llm_provider')).toBe('groq')
  })

  it('memory facts merge by id in both directions', async () => {
    const db = tempDb()
    createMemoryFact(db, { id: 'local-1', fact: 'User uses pnpm' })
    const remote = fakeRemote('user-a')
    remote.tables.synced_memory_facts.push({
      user_id: 'user-a',
      id: 'remote-1',
      fact: 'User likes tea',
      created_at: 1,
      edited_by_user: 0,
      updated_at: 1
    })
    const result = await syncNow(db, remote)
    expect(result.pushed.facts).toBe(1)
    expect(result.pulled.facts).toBe(1)
    const facts = listMemoryFacts(db).map((f) => f.fact)
    expect(facts).toContain('User uses pnpm')
    expect(facts).toContain('User likes tea')
    expect(remote.tables.synced_memory_facts.map((r) => r['id']).sort()).toEqual([
      'local-1',
      'remote-1'
    ])
  })

  it('two users never see each other’s rows (RLS analogue, AC3)', async () => {
    const dbA = tempDb()
    setSetting(dbA, 'tts_enabled', false)
    await pushLocal(dbA, fakeRemote('user-a'))

    const dbB = tempDb()
    setSetting(dbB, 'tts_enabled', true)
    await pushLocal(dbB, fakeRemote('user-b'))

    // Fresh pulls see only their own user's rows (partitioned like RLS).
    const dbA2 = tempDb()
    const pulledA = await pullRemote(dbA2, fakeRemote('user-a'))
    expect(pulledA.settings).toBe(4)
    expect(getSetting(dbA2, 'tts_enabled')).toBe(false)
    const dbC = tempDb()
    await pullRemote(dbC, fakeRemote('user-b'))
    expect(getSetting(dbC, 'tts_enabled')).toBe(true)
    // Cross-user writes are blocked server-side.
    const evil = fakeRemote('user-b')
    await expect(
      evil.upsert('synced_settings', [{ user_id: 'user-a', key: 'x', value: '1', updated_at: 1 }])
    ).rejects.toThrow('cross-user')
  })

  it('skips corrupt remote rows instead of poisoning local state', async () => {
    const db = tempDb()
    const remote = fakeRemote('user-a')
    remote.tables.synced_settings.push(
      { user_id: 'user-a', key: 'tts_enabled', value: '{broken' },
      { user_id: 'user-a', key: 'mystery_key', value: '1' }
    )
    remote.tables.synced_permissions.push({ user_id: 'user-a', action_type: 'x', level: 'sometimes' })
    const pulled = await pullRemote(db, remote)
    expect(pulled).toEqual({ settings: 0, permissions: 0, facts: 0 })
    expect(listPermissions(db).find((p) => p.action_type === 'x')).toBeUndefined()
  })
})
