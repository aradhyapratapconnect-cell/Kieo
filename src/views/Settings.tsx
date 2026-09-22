// src/views/Settings.tsx — permissions, providers, keys, voice (KIEO-053).
//
// Every control writes through the IPC bridge and takes effect on the next
// relevant call with no restart (the agent re-reads settings per call).
// API keys are write-only: the bridge reports only `keySaved` flags, values
// are never displayed, and inputs clear after saving.
import { useCallback, useEffect, useState } from 'react'
import type {
  AutonomySnapshotDto,
  PermissionLevel,
  PermissionStateDto,
  ProvidersSnapshotDto
} from '../../shared/types'
import { useAgentStore } from '../store/useAgentStore'
import WakeWordToggle from '../components/WakeWordToggle'
import CloudSyncSection from './CloudSyncSection'

const LEVEL_OPTIONS: Array<{ value: PermissionLevel; label: string }> = [
  { value: 'always_allow', label: 'Always Allow' },
  { value: 'ask_every_time', label: 'Ask Every Time' },
  { value: 'never_allow', label: 'Never Allow' }
]

function Section({
  title,
  blurb,
  children
}: {
  title: string
  blurb: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-display text-[16px] font-semibold leading-[24px]">{title}</h3>
      <p className="text-[13px] text-text-secondary">{blurb}</p>
      {children}
    </section>
  )
}

export default function SettingsView(): JSX.Element {
  const [permissions, setPermissions] = useState<PermissionStateDto[] | null>(null)
  const [providers, setProviders] = useState<ProvidersSnapshotDto | null>(null)
  const [autonomy, setAutonomy] = useState<AutonomySnapshotDto | null>(null)
  const [ttsEnabled, setTtsEnabled] = useState<boolean | null>(null)
  const setAutonomyBadge = useAgentStore((s) => s.setAutonomyEnabled)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) {
      setError('Settings unavailable outside the desktop app.')
      setPermissions([])
      setProviders(null)
      setAutonomy(null)
      setTtsEnabled(null)
      return
    }
    setError(null)
    api
      .listPermissions()
      .then((rows) => setPermissions(rows))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setPermissions([])
      })
    api.describeProviders().then(
      (snap) => {
        setProviders(snap)
        const drafts: Record<string, string> = {}
        for (const p of snap.providers) drafts[p.id] = p.activeModel
        setModelDrafts(drafts)
      },
      (err) => {
        setError(err instanceof Error ? err.message : String(err))
        setProviders(null)
      }
    )
    api.getSettings().then(
      (settings) => setTtsEnabled(settings['tts_enabled'] !== false),
      () => setTtsEnabled(true)
    )
    api.getAutonomy().then(
      (snap) => {
        setAutonomy(snap)
        setAutonomyBadge(snap.enabled)
      },
      (err) => {
        setError(err instanceof Error ? err.message : String(err))
        setAutonomy(null)
      }
    )
  }, [setAutonomyBadge])

  useEffect(() => {
    load()
  }, [load])

  async function changePermission(actionType: string, level: PermissionLevel): Promise<void> {
    setBusyAction(actionType)
    setError(null)
    setNotice(null)
    try {
      const res = await window.kieo.setPermission(actionType, level)
      if (!res.ok) {
        setError(res.error ?? 'Could not save that permission — try again.')
        return
      }
      setPermissions((prev) =>
        (prev ?? []).map((p) =>
          p.actionType === actionType ? { ...p, level, isDefault: false } : p
        )
      )
      if (res.revoked && res.revoked.length > 0) {
        setNotice(
          `Permission revoked while approval was pending — ${res.revoked.length} pending action(s) denied immediately.`
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function refreshProviders(): Promise<ProvidersSnapshotDto | null> {
    try {
      const snap = await window.kieo.describeProviders()
      setProviders(snap)
      return snap
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async function chooseProvider(providerId: string): Promise<void> {
    setBusyAction(`provider:${providerId}`)
    setError(null)
    try {
      const res = await window.kieo.setActiveProvider(providerId)
      if (!res.ok) {
        setError(res.error ?? 'Could not switch provider — try again.')
        return
      }
      await refreshProviders()
      setNotice(`Active provider is now ${providerId}. Takes effect on the next reply.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function commitModel(providerId: string, fallback: string): Promise<void> {
    const draft = (modelDrafts[providerId] ?? '').trim()
    if (draft === fallback) return
    setBusyAction(`model:${providerId}`)
    setError(null)
    try {
      const res = await window.kieo.setProviderModel(providerId, draft)
      if (!res.ok) {
        setError(res.error ?? 'Could not save that model — try again.')
        return
      }
      const snap = await refreshProviders()
      if (snap) {
        const next = snap.providers.find((p) => p.id === providerId)
        if (next) setModelDrafts((prev) => ({ ...prev, [providerId]: next.activeModel }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function saveKey(providerId: string): Promise<void> {
    const secret = keyDrafts[providerId] ?? ''
    if (!secret) {
      setError('Paste a key before saving.')
      return
    }
    setBusyAction(`key:${providerId}`)
    setError(null)
    try {
      const res = await window.kieo.saveProviderKey(providerId, secret)
      if (!res.ok) {
        setError(res.error ?? 'Could not save that key — try again.')
        return
      }
      setKeyDrafts((prev) => ({ ...prev, [providerId]: '' }))
      setEditingKey(null)
      await refreshProviders()
      setNotice(`Key saved in the OS keychain for ${providerId}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function removeKey(providerId: string): Promise<void> {
    setBusyAction(`key:${providerId}`)
    setError(null)
    try {
      const res = await window.kieo.deleteProviderKey(providerId)
      if (!res.ok) {
        setError(res.error ?? 'Could not remove that key — try again.')
        return
      }
      await refreshProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function toggleAutonomy(enabled: boolean): Promise<void> {
    setBusyAction('autonomy')
    setError(null)
    setNotice(null)
    try {
      const res = await window.kieo.setAutonomyEnabled(enabled)
      if (!res.ok) {
        setError(res.error ?? 'Could not change autonomous mode — try again.')
        return
      }
      setAutonomy((prev) => (prev ? { ...prev, enabled: res.enabled ?? enabled } : prev))
      setAutonomyBadge(res.enabled ?? enabled)
      setNotice(
        enabled
          ? 'Autonomous mode ARMED for this session only — in-scope actions run without asking.'
          : 'Autonomous mode off — every mutating action asks again.'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function toggleScopeAction(actionType: string, inScope: boolean): Promise<void> {
    const current = autonomy?.scope ?? []
    const next = inScope
      ? [...current, actionType]
      : current.filter((a) => a !== actionType)
    setBusyAction(`scope:${actionType}`)
    setError(null)
    try {
      const res = await window.kieo.setAutonomyScope(next)
      if (!res.ok) {
        setError(res.error ?? 'Could not save the scope — try again.')
        return
      }
      const scope = res.scope ?? next
      setAutonomy((prev) =>
        prev
          ? {
              ...prev,
              scope,
              actions: prev.actions.map((a) =>
                a.actionType === actionType ? { ...a, inScope } : a
              )
            }
          : prev
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyAction(null)
    }
  }

  async function toggleTts(enabled: boolean): Promise<void> {
    setTtsEnabled(enabled)
    setError(null)
    try {
      const res = await window.kieo.setSetting('tts_enabled', enabled)
      if (!res.ok) setError('Could not save the voice setting — try again.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const loading =
    permissions === null || providers === null || autonomy === null || ttsEnabled === null

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-6 text-left">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[20px] font-semibold leading-[28px]">Settings</h2>
        <button
          type="button"
          onClick={() => load()}
          className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary"
        >
          Refresh
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="font-mono text-[11px] uppercase tracking-[0.06em] text-safe">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Loading settings…
        </p>
      ) : (
        <>
          <Section
            title="Permissions"
            blurb="Per-action control. Changes apply to the very next matching action — revoking to Never Allow denies even a pending approval immediately."
          >
            <ul className="flex flex-col gap-2">
              {(permissions ?? []).map((perm) => (
                <li
                  key={perm.actionType}
                  className="flex items-center justify-between gap-3 rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]"
                >
                  <div className="min-w-0">
                    <p className="break-all font-mono text-[13px] text-text-primary">
                      {perm.actionType}
                    </p>
                    {perm.isDefault && (
                      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
                        default
                      </p>
                    )}
                  </div>
                  <select
                    value={perm.level}
                    disabled={busyAction === perm.actionType}
                    onChange={(e) =>
                      void changePermission(perm.actionType, e.target.value as PermissionLevel)
                    }
                    aria-label={`Permission for ${perm.actionType}`}
                    className="shrink-0 rounded border border-white/[0.12] bg-bg-base px-2 py-1 font-mono text-[12px] text-text-primary focus:outline-none disabled:opacity-50"
                  >
                    {LEVEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </Section>

          <Section
            title="Autonomous Mode (experimental)"
            blurb="Session-only auto-run for in-scope dangerous actions — no confirmation cards while armed. Disarms on every restart; Never Allow always wins, and everything is still logged."
          >
            <div
              className={`flex flex-col gap-2 rounded border px-3 py-2 backdrop-blur-[16px] ${
                autonomy?.enabled
                  ? 'border-caution/60 bg-caution/10'
                  : 'border-white/[0.07] bg-surface/65'
              }`}
            >
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={autonomy?.enabled ?? false}
                  disabled={busyAction === 'autonomy'}
                  onChange={(e) => void toggleAutonomy(e.target.checked)}
                  className="h-4 w-4 accent-[#F59E0B]"
                />
                <span className="text-[14px] font-semibold text-text-primary">
                  Arm for this session
                </span>
              </label>
              {(autonomy?.actions ?? []).map((action) => (
                <label
                  key={action.actionType}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded border border-white/[0.07] bg-bg-base px-2 py-1"
                >
                  <span className="min-w-0 break-all font-mono text-[12px] text-text-secondary">
                    {action.actionType}
                    <span className="ml-2 text-[11px] uppercase text-text-muted">
                      {action.classification}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={action.inScope}
                    disabled={busyAction === `scope:${action.actionType}`}
                    onChange={(e) => void toggleScopeAction(action.actionType, e.target.checked)}
                    aria-label={`Include ${action.actionType} in autonomous scope`}
                    className="h-4 w-4 shrink-0 accent-[#F59E0B] disabled:opacity-50"
                  />
                </label>
              ))}
              <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
                Scope persists · arming does not — re-arm after every restart
              </p>
            </div>
          </Section>

          <Section
            title="Cloud Sync (experimental)"
            blurb="Optional Supabase sync across machines. The app works fully without it."
          >
            <CloudSyncSection
              notify={(kind, text) => {
                if (kind === 'error') setError(text)
                else setNotice(text)
              }}
            />
          </Section>

          <Section
            title="AI Providers"
            blurb="Bring your own key — stored encrypted in the OS keychain, never shown again. Switching provider or model takes effect on the next reply."
          >
            <ul className="flex flex-col gap-2">
              {(providers?.providers ?? []).map((p) => {
                const busy =
                  busyAction === `provider:${p.id}` ||
                  busyAction === `model:${p.id}` ||
                  busyAction === `key:${p.id}`
                const showKeyInput = !p.keySaved || editingKey === p.id
                return (
                  <li
                    key={p.id}
                    className={`flex flex-col gap-2 rounded border px-3 py-2 backdrop-blur-[16px] ${
                      p.isActive
                        ? 'border-primary/60 bg-surface/65'
                        : 'border-white/[0.07] bg-surface/65'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[15px] font-semibold text-text-primary">
                        {p.label}
                        {p.isActive && (
                          <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.06em] text-primary-bright">
                            active
                          </span>
                        )}
                      </p>
                      {!p.isActive && (
                        <button
                          type="button"
                          onClick={() => void chooseProvider(p.id)}
                          disabled={busy}
                          className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 text-[13px] text-text-secondary hover:text-text-primary disabled:opacity-50"
                        >
                          Use
                        </button>
                      )}
                    </div>
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
                        Model
                      </span>
                      <input
                        value={modelDrafts[p.id] ?? p.activeModel}
                        placeholder={p.defaultModel}
                        spellCheck={false}
                        disabled={busy}
                        onChange={(e) =>
                          setModelDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        onBlur={() => void commitModel(p.id, p.activeModel)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                        aria-label={`Model for ${p.label}`}
                        className="w-full rounded border border-white/[0.12] bg-bg-base px-2 py-1 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50"
                      />
                    </label>
                    {p.hasModelOverride && (
                      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
                        Custom model — clear the field to return to {p.defaultModel}
                      </p>
                    )}
                    {showKeyInput ? (
                      <div className="flex flex-col gap-2">
                        <label className="flex flex-col gap-1">
                          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
                            {p.keySaved ? 'Replace API key (never shown)' : 'API key'}
                          </span>
                          <input
                            type="password"
                            value={keyDrafts[p.id] ?? ''}
                            placeholder="Paste key — stored encrypted, never displayed"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={busy}
                            onChange={(e) =>
                              setKeyDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveKey(p.id)
                              if (e.key === 'Escape') {
                                setKeyDrafts((prev) => ({ ...prev, [p.id]: '' }))
                                setEditingKey(null)
                              }
                            }}
                            aria-label={`API key for ${p.label}`}
                            className="w-full rounded border border-white/[0.12] bg-bg-base px-2 py-1 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50"
                          />
                        </label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void saveKey(p.id)}
                            disabled={busy || !(keyDrafts[p.id] ?? '').trim()}
                            className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base disabled:opacity-50"
                          >
                            Save key
                          </button>
                          {p.keySaved && (
                            <button
                              type="button"
                              onClick={() => {
                                setKeyDrafts((prev) => ({ ...prev, [p.id]: '' }))
                                setEditingKey(null)
                              }}
                              disabled={busy}
                              className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-primary disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-mono text-[12px] text-safe">Saved •••• (keychain)</p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingKey(p.id)}
                            disabled={busy}
                            className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 text-[13px] text-text-secondary hover:text-text-primary disabled:opacity-50"
                          >
                            Replace
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeKey(p.id)}
                            disabled={busy}
                            className="rounded border border-danger/60 bg-danger/10 px-2 py-0.5 text-[13px] text-danger disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </Section>

          <Section
            title="Voice"
            blurb="Wake word listens only when you enable it; responses are spoken unless muted."
          >
            <div className="rounded border border-white/[0.07] bg-surface/65 px-3 py-3 backdrop-blur-[16px]">
              <WakeWordToggle />
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]">
              <input
                type="checkbox"
                checked={!(ttsEnabled ?? true)}
                onChange={(e) => void toggleTts(!e.target.checked)}
                className="h-4 w-4 accent-[#06B6D4]"
              />
              <span className="text-[14px] text-text-primary">Mute spoken responses</span>
            </label>
          </Section>
        </>
      )}
    </div>
  )
}
