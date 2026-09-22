// agent-core/settingsModel.ts — Settings business logic (KIEO-053).
//
// Electron-free pure logic over the SQLite helpers + registry metadata, so
// vitest covers it headlessly. The Electron IPC bridge
// (electron/ipc/settings.ts) is a thin wrapper: validation lives here,
// key material never passes through here at all (the bridge talks to the
// key store directly and only ever reports `keySaved: boolean` outward).
//
// Immediacy (ticket AC1) is structural, not re-read here: resolveModel()
// (KIEO-010), resolvePermissionPolicy() (KIEO-014), and shouldSpeakResponse()
// all read settings fresh on every call, so anything written through this
// module applies to the very next action with no restart.
import type { DatabaseHandle } from '../db/database'
import {
  getSetting,
  listPermissions,
  setPermission,
  setSetting,
  type PermissionRow
} from '../db/tables'
import type { PermissionLevel } from '../shared/types'
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_IDS,
  PROVIDER_METADATA,
  SETTING_ACTIVE_PROVIDER,
  SETTING_LLM_MODELS,
  isProviderId,
  type ProviderId
} from './llm/provider'
import type { ToolRegistry } from './tools/registry'
import { SETTING_TTS_ENABLED } from './voice/tts'

export type SettingsModelErrorCode = 'unknown-action' | 'invalid-level' | 'unknown-provider'

export class SettingsModelError extends Error {
  readonly code: SettingsModelErrorCode

  constructor(code: SettingsModelErrorCode, message: string) {
    super(message)
    this.name = 'SettingsModelError'
    this.code = code
  }
}

const PERMISSION_LEVELS: PermissionLevel[] = ['always_allow', 'ask_every_time', 'never_allow']

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return (
    value === 'always_allow' || value === 'ask_every_time' || value === 'never_allow'
  )
}

// ---------------------------------------------------------------------------
// Permissions — driven by the registry (ticket AC3: no manual sync)
// ---------------------------------------------------------------------------

export interface PermissionState {
  actionType: string
  level: PermissionLevel
  /** True when no explicit row exists yet (the ask_every_time default). */
  isDefault: boolean
}

/**
 * Every action type the registry knows, in registration order, with its
 * current level (or the ask_every_time default). Registering a new tool is
 * enough for it to appear here — nothing else lists action types.
 */
export function listPermissionStates(
  db: DatabaseHandle,
  registry: ToolRegistry
): PermissionState[] {
  const rows = new Map<string, PermissionRow>(
    listPermissions(db).map((r) => [r.action_type, r])
  )
  return registry.listTools().map((t) => {
    const row = rows.get(t.permissionActionType)
    if (!row) {
      return { actionType: t.permissionActionType, level: 'ask_every_time' as const, isDefault: true }
    }
    return { actionType: t.permissionActionType, level: row.level, isDefault: false }
  })
}

/** Validate + write a permission level. Throws SettingsModelError. */
export function setPermissionLevel(
  db: DatabaseHandle,
  registry: ToolRegistry,
  actionType: string,
  level: string
): PermissionRow {
  const known = new Set(registry.listTools().map((t) => t.permissionActionType))
  if (!known.has(actionType)) {
    throw new SettingsModelError(
      'unknown-action',
      `Unknown action type "${actionType}" — it is not in the tool registry.`
    )
  }
  if (!isPermissionLevel(level)) {
    throw new SettingsModelError(
      'invalid-level',
      `Invalid permission level "${String(level)}" — use ${PERMISSION_LEVELS.join(', ')}.`
    )
  }
  return setPermission(db, actionType, level)
}

// ---------------------------------------------------------------------------
// Providers + keys (BYOK). Key VALUES never appear here — only flags.
// ---------------------------------------------------------------------------

export interface ProviderState {
  id: ProviderId
  label: string
  defaultModel: string
  /** Model actually used: per-provider override, else the default. */
  activeModel: string
  /** True when the user typed a custom model (vs. the default). */
  hasModelOverride: boolean
  /** True when a key is stored in the OS keychain (value never exposed). */
  keySaved: boolean
  isActive: boolean
}

export function getActiveProviderId(db: DatabaseHandle): ProviderId {
  const configured = getSetting<string>(db, SETTING_ACTIVE_PROVIDER)
  return isProviderId(configured) ? configured : DEFAULT_PROVIDER_ID
}

export function setActiveProvider(db: DatabaseHandle, providerId: string): ProviderId {
  if (!isProviderId(providerId)) {
    throw new SettingsModelError(
      'unknown-provider',
      `"${String(providerId)}" is not a supported provider (${PROVIDER_IDS.join(', ')}).`
    )
  }
  setSetting(db, SETTING_ACTIVE_PROVIDER, providerId)
  return providerId
}

function readModelOverrides(db: DatabaseHandle): Record<string, string> {
  return getSetting<Record<string, string>>(db, SETTING_LLM_MODELS) ?? {}
}

/** Set a per-provider model override; empty string clears back to default. */
export function setProviderModel(
  db: DatabaseHandle,
  providerId: string,
  model: string
): string {
  if (!isProviderId(providerId)) {
    throw new SettingsModelError(
      'unknown-provider',
      `"${String(providerId)}" is not a supported provider (${PROVIDER_IDS.join(', ')}).`
    )
  }
  const overrides = readModelOverrides(db)
  const trimmed = model.trim()
  if (!trimmed) {
    delete overrides[providerId]
  } else {
    overrides[providerId] = trimmed
  }
  setSetting(db, SETTING_LLM_MODELS, overrides)
  return trimmed || PROVIDER_METADATA[providerId].defaultModel
}

/**
 * Full provider snapshot for the Settings UI. `savedKeyNames` comes from
 * keyStore.listProviders() — names only, never values — so it is
 * structurally impossible for this output to leak a secret (pinned by test).
 */
export function describeProviders(
  db: DatabaseHandle,
  savedKeyNames: string[]
): { activeProviderId: ProviderId; providers: ProviderState[] } {
  const activeProviderId = getActiveProviderId(db)
  const overrides = readModelOverrides(db)
  const saved = new Set(savedKeyNames)
  const providers = (PROVIDER_IDS as readonly ProviderId[]).map((id) => {
    const meta = PROVIDER_METADATA[id]
    const override = overrides[id]
    return {
      id,
      label: meta.label,
      defaultModel: meta.defaultModel,
      activeModel: override ?? meta.defaultModel,
      hasModelOverride: override !== undefined,
      keySaved: saved.has(meta.keyStoreName),
      isActive: id === activeProviderId
    }
  })
  return { activeProviderId, providers }
}

// ---------------------------------------------------------------------------
// TTS mute (read per turn by shouldSpeakResponse — immediate by construction)
// ---------------------------------------------------------------------------

export function isTtsEnabled(db: DatabaseHandle): boolean {
  return getSetting<boolean>(db, SETTING_TTS_ENABLED) !== false
}

export function setTtsEnabled(db: DatabaseHandle, enabled: boolean): boolean {
  setSetting(db, SETTING_TTS_ENABLED, enabled)
  return enabled
}

// ---------------------------------------------------------------------------
// Onboarding (KIEO-064): first-launch guide flag. Absent means unseen.
// ---------------------------------------------------------------------------

export const SETTING_ONBOARDING_SEEN = 'onboarding_seen'

export function hasSeenOnboarding(db: DatabaseHandle): boolean {
  return getSetting<boolean>(db, SETTING_ONBOARDING_SEEN) === true
}

export function markOnboardingSeen(db: DatabaseHandle): void {
  setSetting(db, SETTING_ONBOARDING_SEEN, true)
}
