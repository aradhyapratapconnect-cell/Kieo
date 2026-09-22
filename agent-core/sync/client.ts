// agent-core/sync/client.ts — Supabase session + remote adapter (KIEO-061).
//
// The `@supabase/supabase-js` package is an OPTIONAL peer: it is loaded with
// a dynamic import only when the user actually signs in, so the app boots,
// builds, and runs fully without it (ticket AC1). When absent (or the
// project is unconfigured) every entry point fails with a typed, catchable
// SyncClientError — never a crash, never a silent no-op.
//
// Session, like autonomy arming, lives in main-process memory: signing in is
// an explicit per-launch act and sign-out (or quit) drops the token. The
// project URL sits in settings (not secret); the anon key lives in the OS
// keychain next to the LLM keys.
import type { DatabaseHandle } from '../../db/database'
import { getSetting, setSetting } from '../../db/tables'
import type { SyncRemote, SyncTable } from './engine'

export const SETTING_SUPABASE_URL = 'supabase_url'
export const KEYSTORE_SUPABASE_ANON_KEY = 'supabase_anon_key'

export type SyncClientErrorCode = 'not-configured' | 'not-installed' | 'auth-failed' | 'remote-failed'

export class SyncClientError extends Error {
  readonly code: SyncClientErrorCode

  constructor(code: SyncClientErrorCode, message: string) {
    super(message)
    this.name = 'SyncClientError'
    this.code = code
  }
}

/** Structural minimum of supabase-js used here (keeps us decoupled). */
export interface SupabaseJsClient {
  auth: {
    signInWithPassword(creds: { email: string; password: string }): Promise<{
      data: { user: { id: string; email?: string } | null }
      error: { message: string } | null
    }>
    signOut(): Promise<{ error: { message: string } | null }>
  }
  from(table: string): {
    select(): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>
    upsert(rows: Record<string, unknown>[]): Promise<{ error: { message: string } | null }>
  }
}

export type SupabaseImporter = () => Promise<{ createClient: unknown }>

/** Default loader: dynamic import so the dependency stays optional. */
export async function defaultImporter(): Promise<{ createClient: unknown }> {
  try {
    // @ts-ignore — optional peer dependency; typed as unknown below.
    const mod = await import('@supabase/supabase-js')
    return mod as { createClient: unknown }
  } catch {
    throw new SyncClientError(
      'not-installed',
      'Cloud sync needs the optional @supabase/supabase-js package (npm i @supabase/supabase-js), then sign in again.'
    )
  }
}

export interface SyncSession {
  userId: string
  email: string | null
}

let session: SyncSession | null = null
let client: SupabaseJsClient | null = null

export function getSyncSession(): SyncSession | null {
  return session
}

export function getSupabaseUrl(db: DatabaseHandle): string | null {
  const raw = getSetting<string>(db, SETTING_SUPABASE_URL)
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

export function setSupabaseUrl(db: DatabaseHandle, url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) {
    setSetting(db, SETTING_SUPABASE_URL, '')
    return null
  }
  if (!/^https?:\/\/.+\..+/.test(trimmed)) {
    throw new SyncClientError(
      'not-configured',
      'That Supabase URL looks invalid — use the https project URL from the Supabase dashboard.'
    )
  }
  setSetting(db, SETTING_SUPABASE_URL, trimmed)
  return trimmed
}

function createClientFrom(
  factory: unknown,
  url: string,
  anonKey: string
): SupabaseJsClient {
  const createClient = (factory as { createClient?: unknown })?.createClient
  if (typeof createClient !== 'function') {
    throw new SyncClientError(
      'not-installed',
      'Cloud sync needs the optional @supabase/supabase-js package (npm i @supabase/supabase-js), then sign in again.'
    )
  }
  return (createClient as (url: string, key: string) => SupabaseJsClient)(url, anonKey)
}

export async function signIn(
  db: DatabaseHandle,
  anonKey: string | null,
  email: string,
  password: string,
  importer: SupabaseImporter = defaultImporter
): Promise<SyncSession> {
  const url = getSupabaseUrl(db)
  if (!url || !anonKey) {
    throw new SyncClientError(
      'not-configured',
      'Set the Supabase project URL and anon key in Settings → Cloud Sync first.'
    )
  }
  if (!email.trim() || !password) {
    throw new SyncClientError('auth-failed', 'Email and password are required.')
  }
  const factory = await importer()
  const next = createClientFrom(factory, url, anonKey)
  let result: Awaited<ReturnType<SupabaseJsClient['auth']['signInWithPassword']>>
  try {
    result = await next.auth.signInWithPassword({ email: email.trim(), password })
  } catch (err) {
    throw new SyncClientError(
      'remote-failed',
      `Couldn't reach the Supabase project: ${err instanceof Error ? err.message : String(err)}.`
    )
  }
  if (result.error || !result.data.user) {
    throw new SyncClientError(
      'auth-failed',
      `Sign-in failed: ${result.error?.message ?? 'unknown error'}. Check the email/password.`
    )
  }
  session = { userId: result.data.user.id, email: result.data.user.email ?? null }
  client = next
  return session
}

export async function signOut(): Promise<void> {
  try {
    await client?.auth.signOut()
  } catch {
    // Dropping the local session is what matters; a failed server call
    // must not keep the token alive client-side.
  }
  session = null
  client = null
}

/** Adapter exposing the signed-in client as a SyncRemote for the engine. */
export function getSyncRemote(): SyncRemote {
  const active = session
  const activeClient = client
  return {
    getUserId: () => active?.userId ?? null,
    list: async (table: SyncTable) => {
      if (!active || !activeClient) return []
      const res = await activeClient.from(table).select()
      if (res.error || !res.data) {
        throw new SyncClientError('remote-failed', `Sync read failed: ${res.error?.message ?? table}.`)
      }
      return res.data
    },
    upsert: async (table: SyncTable, rows: Record<string, unknown>[]) => {
      if (!active || !activeClient) {
        throw new SyncClientError(
          'remote-failed',
          'Cloud sync needs sign-in first — local data is untouched.'
        )
      }
      if (rows.length === 0) return
      const res = await activeClient.from(table).upsert(rows)
      if (res.error) {
        throw new SyncClientError('remote-failed', `Sync write failed: ${res.error.message}.`)
      }
    }
  }
}
