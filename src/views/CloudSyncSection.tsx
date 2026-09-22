// src/views/CloudSyncSection.tsx — opt-in cloud sync controls (KIEO-061).
//
// Disabled and signed out by default: every action here requires explicit
// sign-in, and syncing never touches conversations, tool payloads, or keys.
// What syncs (stated plainly per ticket AC2): the allowlisted app settings,
// permission levels, and memory facts — each row owned by the signed-in user
// and guarded server-side by RLS (supabase/schema.sql).
import { useCallback, useEffect, useState } from 'react'

interface Status {
  signedIn: boolean
  userId: string | null
  email: string | null
  urlConfigured: boolean
}

export default function CloudSyncSection({
  notify
}: {
  notify: (kind: 'error' | 'notice', text: string) => void
}): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [url, setUrl] = useState('')
  const [anonKey, setAnonKey] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<string | null>(null)

  const refresh = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) return
    api
      .getSyncStatus()
      .then((s) => setStatus(s))
      .catch(() => setStatus(null))
    api
      .getSyncConfig()
      .then((c) => {
        if (c.url) setUrl(c.url)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function saveConfig(): Promise<void> {
    setBusy('config')
    try {
      const res = await window.kieo.setSyncConfig(url.trim(), anonKey || undefined)
      if (!res.ok) {
        notify('error', res.error ?? 'Could not save the sync config — try again.')
        return
      }
      setAnonKey('')
      notify('notice', 'Sync project saved. Sign in to enable syncing.')
      refresh()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function signIn(): Promise<void> {
    setBusy('signin')
    try {
      const res = await window.kieo.syncSignIn(email.trim(), password)
      if (!res.ok) {
        notify('error', res.error ?? 'Sign-in failed — check the email/password.')
        return
      }
      setPassword('')
      notify('notice', `Signed in${res.email ? ` as ${res.email}` : ''} — sync is now available.`)
      refresh()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function signOut(): Promise<void> {
    setBusy('signout')
    try {
      await window.kieo.syncSignOut()
      setLastSync(null)
      notify('notice', 'Signed out — the local app is unaffected.')
      refresh()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function syncNow(): Promise<void> {
    setBusy('sync')
    try {
      const res = await window.kieo.syncNow()
      if (!res.ok) {
        notify('error', res.error ?? 'Sync failed — local data is untouched.')
        return
      }
      const pushed = res.pushed ?? { settings: 0, permissions: 0, facts: 0 }
      const pulled = res.pulled ?? { settings: 0, permissions: 0, facts: 0 }
      setLastSync(
        `Pushed ${pushed.settings + pushed.permissions + pushed.facts} · ` +
          `pulled ${pulled.settings + pulled.permissions + pulled.facts}`
      )
      refresh()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const inputClass =
    'w-full rounded border border-white/[0.12] bg-bg-base px-2 py-1 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50'

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-text-secondary">
        Syncs app settings, permission levels, and memory facts — never API keys,
        conversations, or tool payloads. Off until you sign in.
      </p>
      <div className="rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]">
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Status
        </p>
        <p className="mt-0.5 text-[14px] text-text-primary">
          {status === null
            ? 'Loading…'
            : status.signedIn
              ? `Signed in${status.email ? ` as ${status.email}` : ''}`
              : status.urlConfigured
                ? 'Configured — signed out'
                : 'Disabled — no project configured'}
        </p>
        {lastSync !== null && (
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-safe">
            Last sync: {lastSync}
          </p>
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Supabase project URL
        </span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://xyz.supabase.co"
          spellCheck={false}
          autoComplete="off"
          disabled={busy !== null}
          aria-label="Supabase project URL"
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Anon key (stored in the OS keychain, never shown)
        </span>
        <input
          type="password"
          value={anonKey}
          onChange={(e) => setAnonKey(e.target.value)}
          placeholder="Leave blank to keep the saved key"
          autoComplete="off"
          spellCheck={false}
          disabled={busy !== null}
          aria-label="Supabase anon key"
          className={inputClass}
        />
      </label>
      <div>
        <button
          type="button"
          onClick={() => void saveConfig()}
          disabled={busy !== null || !url.trim()}
          className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-primary disabled:opacity-50"
        >
          Save project
        </button>
      </div>

      {status?.signedIn ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void syncNow()}
            disabled={busy !== null}
            className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base disabled:opacity-50"
          >
            Sync now
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={busy !== null}
            className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-primary disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded border border-white/[0.07] bg-bg-base px-3 py-2">
          <div className="flex flex-col gap-1 sm:flex-row">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              spellCheck={false}
              disabled={busy !== null}
              aria-label="Sync account email"
              className={inputClass}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              disabled={busy !== null}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void signIn()
              }}
              aria-label="Sync account password"
              className={inputClass}
            />
          </div>
          <div>
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={busy !== null || !email.trim() || !password}
              className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base disabled:opacity-50"
            >
              Sign in
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
