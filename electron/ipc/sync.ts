// electron/ipc/sync.ts — Cloud Sync IPC bridge (KIEO-061, opt-in).
//
// Everything here is explicit and disabled by default: with no session,
// sync-now fails closed and local data is never touched (ticket AC1).
// Enabling requires sign-in (AC2), and the Settings UI states exactly what
// syncs (settings allowlist, permissions, memory facts — never keys,
// conversations, or tool payloads).
import { ipcMain } from 'electron'
import { getDatabase } from '../../db/database'
import { SyncError, syncNow } from '../../agent-core/sync/engine'
import {
  KEYSTORE_SUPABASE_ANON_KEY,
  SyncClientError,
  getSupabaseUrl,
  getSyncRemote,
  getSyncSession,
  setSupabaseUrl,
  signIn,
  signOut
} from '../../agent-core/sync/client'
import { getKeyStore, KeyStoreError } from '../secure/keyStore'

function clientErrorPayload(err: unknown): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false as const, error: message }
}

export function registerSyncIpc(): void {
  ipcMain.handle('sync-status', async () => {
    const db = getDatabase()
    const session = getSyncSession()
    return {
      signedIn: session !== null,
      userId: session?.userId ?? null,
      email: session?.email ?? null,
      urlConfigured: getSupabaseUrl(db) !== null
    }
  })

  ipcMain.handle('sync-config-get', async () => {
    return { url: getSupabaseUrl(getDatabase()) }
  })

  ipcMain.handle(
    'sync-config-set',
    async (_event, payload: { url?: unknown; anonKey?: unknown }) => {
      if (typeof payload?.url !== 'string') {
        return { ok: false as const, error: 'A project URL string is required.' }
      }
      const db = getDatabase()
      try {
        const url = setSupabaseUrl(db, payload.url)
        if (typeof payload?.anonKey === 'string' && payload.anonKey.length > 0) {
          getKeyStore().saveKey(KEYSTORE_SUPABASE_ANON_KEY, payload.anonKey)
        }
        return { ok: true as const, url }
      } catch (err) {
        if (err instanceof SyncClientError || err instanceof KeyStoreError) {
          return clientErrorPayload(err)
        }
        throw err
      }
    }
  )

  ipcMain.handle(
    'sync-signin',
    async (_event, payload: { email?: unknown; password?: unknown }) => {
      if (typeof payload?.email !== 'string' || typeof payload?.password !== 'string') {
        return { ok: false as const, error: 'Email and password are required.' }
      }
      const db = getDatabase()
      let anonKey: string | null = null
      try {
        anonKey = getKeyStore().getKey(KEYSTORE_SUPABASE_ANON_KEY)
      } catch {
        anonKey = null
      }
      try {
        const session = await signIn(db, anonKey, payload.email, payload.password)
        return { ok: true as const, userId: session.userId, email: session.email }
      } catch (err) {
        if (err instanceof SyncClientError) return clientErrorPayload(err)
        throw err
      }
    }
  )

  ipcMain.handle('sync-signout', async () => {
    await signOut()
    return { ok: true as const }
  })

  ipcMain.handle('sync-now', async () => {
    const db = getDatabase()
    try {
      const result = await syncNow(db, getSyncRemote())
      return { ok: true as const, ...result }
    } catch (err) {
      if (err instanceof SyncError || err instanceof SyncClientError) {
        return clientErrorPayload(err)
      }
      throw err
    }
  })
}
