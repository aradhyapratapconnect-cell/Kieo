// agent-core/sync/client.test.ts — KIEO-061 session coverage (pnpm test).
//
// Fake importer (no @supabase/supabase-js needed): proves explicit opt-in
// (signed out by default), validation before any network, and session drop
// on sign-out — all against a temp DB.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import {
  getSupabaseUrl,
  getSyncRemote,
  getSyncSession,
  setSupabaseUrl,
  signIn,
  signOut,
  SyncClientError,
  type SupabaseJsClient
} from './client'

let dirs: string[] = []

afterEach(async () => {
  await signOut()
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-sync-client-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

function fakeImporter(
  user: { id: string; email?: string } | null,
  authError: string | null = null
): () => Promise<{ createClient: unknown }> {
  const fake: SupabaseJsClient = {
    auth: {
      signInWithPassword: async () =>
        authError || !user
          ? { data: { user: null }, error: { message: authError ?? 'bad login' } }
          : { data: { user }, error: null },
      signOut: async () => ({ error: null })
    },
    from: () => ({
      select: async () => ({ data: [], error: null }),
      upsert: async () => ({ error: null })
    })
  }
  return async () => ({ createClient: () => fake })
}

describe('KIEO-061 sync client (explicit opt-in, AC1+AC2)', () => {
  it('starts signed out; sync-now surface reports null user', () => {
    expect(getSyncSession()).toBeNull()
    expect(getSyncRemote().getUserId()).toBeNull()
  })

  it('requires project URL + anon key before any network (AC2)', async () => {
    const db = tempDb()
    await expect(signIn(db, 'key', 'a@b.c', 'pw', fakeImporter({ id: 'u' }))).rejects.toMatchObject({
      name: 'SyncClientError',
      code: 'not-configured'
    })
    setSupabaseUrl(db, 'https://xyz.supabase.co')
    await expect(
      signIn(db, null, 'a@b.c', 'pw', fakeImporter({ id: 'u' }))
    ).rejects.toMatchObject({ code: 'not-configured' })
  })

  it('rejects malformed project URLs at config time', () => {
    const db = tempDb()
    expect(() => setSupabaseUrl(db, 'not-a-url')).toThrowError(SyncClientError)
    expect(getSupabaseUrl(db)).toBeNull()
    expect(setSupabaseUrl(db, 'https://xyz.supabase.co')).toBe('https://xyz.supabase.co')
  })

  it('signs in, exposes the session, and drops it on sign-out', async () => {
    const db = tempDb()
    setSupabaseUrl(db, 'https://xyz.supabase.co')
    const session = await signIn(db, 'anon-key', 'a@b.c', 'pw', fakeImporter({ id: 'u-1', email: 'a@b.c' }))
    expect(session).toMatchObject({ userId: 'u-1', email: 'a@b.c' })
    expect(getSyncSession()?.userId).toBe('u-1')
    expect(getSyncRemote().getUserId()).toBe('u-1')
    await signOut()
    expect(getSyncSession()).toBeNull()
    expect(getSyncRemote().getUserId()).toBeNull()
  })

  it('surfaces auth failures plainly without a session', async () => {
    const db = tempDb()
    setSupabaseUrl(db, 'https://xyz.supabase.co')
    await expect(
      signIn(db, 'anon-key', 'a@b.c', 'wrong', fakeImporter(null, 'Invalid login credentials'))
    ).rejects.toMatchObject({ name: 'SyncClientError', code: 'auth-failed' })
    expect(getSyncSession()).toBeNull()
  })
})
