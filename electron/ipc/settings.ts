// electron/ipc/settings.ts — Settings IPC bridge (KIEO-053).
//
// Thin wrappers over agent-core/settingsModel.ts (validation + SQLite) and
// the encrypted key store (secrets). Key VALUES never cross IPC in either
// direction as data: saves take a one-way secret in, describes report only
// `keySaved` flags out, and error messages name providers — never secrets
// (the key store guarantees this).
//
// Immediacy: every write here lands in the same SQLite rows / key store the
// agent reads fresh on each call (provider+model+key per LLM call, permission
// per tool call, TTS per turn), so Settings changes apply with no restart.
// Permission writes additionally call reevaluatePendingApprovals() so a
// mid-approval revocation to Never Allow denies immediately (KIEO-014 edge).
import { ipcMain } from 'electron'
import { getDatabase } from '../../db/database'
import {
  PROVIDER_METADATA,
  isProviderId,
  type ProviderId
} from '../../agent-core/llm/provider'
import {
  AutonomousModelError,
  getAutonomousScope,
  isAutonomousEnabled,
  listAutonomousActions,
  setAutonomousEnabled,
  setAutonomousScope
} from '../../agent-core/autonomous'
import {
  SETTING_ONBOARDING_SEEN,
  SettingsModelError,
  describeProviders,
  hasSeenOnboarding,
  isTtsEnabled,
  listPermissionStates,
  markOnboardingSeen,
  setActiveProvider,
  setPermissionLevel,
  setProviderModel,
  setTtsEnabled
} from '../../agent-core/settingsModel'
import { toolRegistry } from '../../agent-core/tools/registry'
import { SETTING_TTS_ENABLED } from '../../agent-core/voice/tts'
import { getKeyStore, KeyStoreError } from '../secure/keyStore'
import { reevaluatePendingApprovals } from './hitl'

function modelErrorPayload(err: unknown): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false as const, error: message }
}

export function registerSettingsIpc(): void {
  // Generic settings surface (allowlisted — only UI-owned keys, never
  // secrets; secrets live exclusively in the key store).
  ipcMain.handle('settings-get', async () => {
    const db = getDatabase()
    return {
      [SETTING_TTS_ENABLED]: isTtsEnabled(db),
      [SETTING_ONBOARDING_SEEN]: hasSeenOnboarding(db)
    }
  })
  ipcMain.handle(
    'settings-set',
    async (_event, payload: { key?: unknown; value?: unknown }) => {
      if (typeof payload?.value !== 'boolean') {
        return { ok: false as const }
      }
      const db = getDatabase()
      if (payload?.key === SETTING_TTS_ENABLED) {
        setTtsEnabled(db, payload.value)
        return { ok: true as const }
      }
      // KIEO-064: first-launch guide flag. Replay from Settings opens the
      // overlay directly without touching this flag.
      if (payload?.key === SETTING_ONBOARDING_SEEN && payload.value === true) {
        markOnboardingSeen(db)
        return { ok: true as const }
      }
      return { ok: false as const }
    }
  )

  ipcMain.handle('permissions-list', async () => {
    return listPermissionStates(getDatabase(), toolRegistry)
  })
  ipcMain.handle(
    'permissions-set',
    async (_event, payload: { actionType?: unknown; level?: unknown }) => {
      const db = getDatabase()
      try {
        if (typeof payload?.actionType !== 'string' || typeof payload?.level !== 'string') {
          return { ok: false as const, error: 'actionType and level are required.' }
        }
        setPermissionLevel(db, toolRegistry, payload.actionType, payload.level)
      } catch (err) {
        if (err instanceof SettingsModelError) return modelErrorPayload(err)
        throw err
      }
      // Revocation takes effect on the very next call AND kills a matching
      // pending approval immediately (never left in limbo).
      const revoked = reevaluatePendingApprovals(db)
      return { ok: true as const, revoked }
    }
  )

  ipcMain.handle('providers-describe', async () => {
    const db = getDatabase()
    let saved: string[] = []
    try {
      saved = getKeyStore().listProviders()
    } catch {
      // Uninitialized key store (early startup): report no saved keys.
      saved = []
    }
    return describeProviders(db, saved)
  })
  ipcMain.handle(
    'providers-set-active',
    async (_event, payload: { providerId?: unknown }) => {
      try {
        if (typeof payload?.providerId !== 'string') {
          return { ok: false as const, error: 'providerId is required.' }
        }
        setActiveProvider(getDatabase(), payload.providerId)
        return { ok: true as const }
      } catch (err) {
        if (err instanceof SettingsModelError) return modelErrorPayload(err)
        throw err
      }
    }
  )
  ipcMain.handle(
    'providers-set-model',
    async (_event, payload: { providerId?: unknown; model?: unknown }) => {
      try {
        if (typeof payload?.providerId !== 'string' || typeof payload?.model !== 'string') {
          return { ok: false as const, error: 'providerId and model are required.' }
        }
        const activeModel = setProviderModel(getDatabase(), payload.providerId, payload.model)
        return { ok: true as const, activeModel }
      } catch (err) {
        if (err instanceof SettingsModelError) return modelErrorPayload(err)
        throw err
      }
    }
  )
  ipcMain.handle(
    'providers-save-key',
    async (_event, payload: { providerId?: unknown; key?: unknown }) => {
      if (typeof payload?.providerId !== 'string' || typeof payload?.key !== 'string') {
        return { ok: false as const, error: 'providerId and key are required.' }
      }
      if (!isProviderId(payload.providerId)) {
        return { ok: false as const, error: `Unknown provider "${payload.providerId}".` }
      }
      const meta = PROVIDER_METADATA[payload.providerId as ProviderId]
      try {
        getKeyStore().saveKey(meta.keyStoreName, payload.key)
        return { ok: true as const }
      } catch (err) {
        if (err instanceof KeyStoreError) return modelErrorPayload(err)
        throw err
      }
    }
  )
  ipcMain.handle(
    'providers-delete-key',
    async (_event, payload: { providerId?: unknown }) => {
      if (typeof payload?.providerId !== 'string') {
        return { ok: false as const, error: 'providerId is required.' }
      }
      if (!isProviderId(payload.providerId)) {
        return { ok: false as const, error: `Unknown provider "${payload.providerId}".` }
      }
      const meta = PROVIDER_METADATA[payload.providerId as ProviderId]
      try {
        const deleted = getKeyStore().deleteKey(meta.keyStoreName)
        return { ok: true as const, deleted }
      } catch (err) {
        if (err instanceof KeyStoreError) return modelErrorPayload(err)
        throw err
      }
    }
  )

  // KIEO-060 autonomous mode: session arming + persisted scope. The enabled
  // flag is intentionally NOT stored — every launch starts disarmed.
  ipcMain.handle('autonomy-get', async () => {
    const db = getDatabase()
    return {
      enabled: isAutonomousEnabled(),
      scope: getAutonomousScope(db),
      actions: listAutonomousActions(db, toolRegistry)
    }
  })
  ipcMain.handle('autonomy-set-enabled', async (_event, payload: { enabled?: unknown }) => {
    if (typeof payload?.enabled !== 'boolean') {
      return { ok: false as const, error: 'enabled must be a boolean.' }
    }
    const enabled = setAutonomousEnabled(payload.enabled)
    return { ok: true as const, enabled }
  })
  ipcMain.handle('autonomy-set-scope', async (_event, payload: { actions?: unknown }) => {
    if (!Array.isArray(payload?.actions) || !payload.actions.every((a) => typeof a === 'string')) {
      return { ok: false as const, error: 'actions must be an array of action-type strings.' }
    }
    try {
      const scope = setAutonomousScope(getDatabase(), toolRegistry, payload.actions as string[])
      return { ok: true as const, scope }
    } catch (err) {
      if (err instanceof AutonomousModelError) return modelErrorPayload(err)
      throw err
    }
  })
}
