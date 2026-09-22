// agent-core/settingsModel.test.ts — KIEO-053 logic coverage (pnpm test).
//
// Temp-DB tests over the real tables + registry: registry-driven permission
// listing (AC3), provider snapshots that can never leak key material (AC2),
// and validation. No Electron, no keychain.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { DatabaseHandle } from '../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../db/database'
import { toolRegistry, createToolRegistry } from './tools/registry'
import {
  SettingsModelError,
  describeProviders,
  getActiveProviderId,
  hasSeenOnboarding,
  isTtsEnabled,
  listPermissionStates,
  markOnboardingSeen,
  setActiveProvider,
  setPermissionLevel,
  setProviderModel,
  setTtsEnabled
} from './settingsModel'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-settings-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-053 permissions (registry-driven, AC3)', () => {
  it('lists every registry action type with ask_every_time defaults', () => {
    const db = tempDb()
    const states = listPermissionStates(db, toolRegistry)
    const expected = toolRegistry.listTools().map((t) => t.permissionActionType)
    expect(states.map((s) => s.actionType)).toEqual(expected)
    // Effective default everywhere (migration seeds the dangerous rows, so
    // those are explicit rows at the same default level).
    expect(states.every((s) => s.level === 'ask_every_time')).toBe(true)
    expect(states.find((s) => s.actionType === 'delete_file')?.isDefault).toBe(false)
    expect(states.find((s) => s.actionType === 'read_file')?.isDefault).toBe(true)
  })

  it('a newly registered tool appears automatically', () => {
    const db = tempDb()
    const extended = createToolRegistry([
      ...toolRegistry.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        classification: t.classification,
        inputShape: t.inputShape
      })),
      {
        name: 'future_tool',
        description: 'From the future.',
        classification: 'dangerous' as const,
        inputShape: { q: z.string() }
      }
    ])
    const states = listPermissionStates(db, extended)
    expect(states.map((s) => s.actionType)).toContain('future_tool')
  })

  it('writes round-trip and rejects unknown actions/levels', () => {
    const db = tempDb()
    const row = setPermissionLevel(db, toolRegistry, 'delete_file', 'never_allow')
    expect(row.level).toBe('never_allow')
    const states = listPermissionStates(db, toolRegistry)
    expect(states.find((s) => s.actionType === 'delete_file')).toMatchObject({
      level: 'never_allow',
      isDefault: false
    })
    expect(() => setPermissionLevel(db, toolRegistry, 'nope', 'never_allow')).toThrowError(
      SettingsModelError
    )
    expect(() => setPermissionLevel(db, toolRegistry, 'delete_file', 'sometimes')).toThrowError(
      SettingsModelError
    )
  })
})

describe('KIEO-053 providers (AC2: keys never exposed)', () => {
  it('defaults to openai with catalogue models and no saved keys', () => {
    const db = tempDb()
    expect(getActiveProviderId(db)).toBe('openai')
    const { activeProviderId, providers } = describeProviders(db, [])
    expect(activeProviderId).toBe('openai')
    expect(providers).toHaveLength(5)
    expect(providers.find((p) => p.id === 'openai')).toMatchObject({
      label: 'OpenAI',
      defaultModel: 'gpt-4o-mini',
      activeModel: 'gpt-4o-mini',
      hasModelOverride: false,
      keySaved: false,
      isActive: true
    })
  })

  it('switching provider + model override round-trips', () => {
    const db = tempDb()
    expect(setActiveProvider(db, 'anthropic')).toBe('anthropic')
    expect(getActiveProviderId(db)).toBe('anthropic')
    expect(setProviderModel(db, 'anthropic', 'claude-opus-4-0')).toBe('claude-opus-4-0')
    const { providers } = describeProviders(db, [])
    expect(providers.find((p) => p.id === 'anthropic')).toMatchObject({
      activeModel: 'claude-opus-4-0',
      hasModelOverride: true
    })
    // Empty clears back to the default.
    expect(setProviderModel(db, 'anthropic', '   ')).toBe('claude-sonnet-4-5')
    expect(
      describeProviders(db, []).providers.find((p) => p.id === 'anthropic')
    ).toMatchObject({ hasModelOverride: false, activeModel: 'claude-sonnet-4-5' })
    expect(() => setActiveProvider(db, 'skynet')).toThrowError(SettingsModelError)
  })

  it('key snapshots carry flags only — secret values cannot leak', () => {
    const db = tempDb()
    const SECRET = 'sk-super-secret-value-12345'
    const { providers } = describeProviders(db, ['openai'])
    expect(providers.find((p) => p.id === 'openai')?.keySaved).toBe(true)
    expect(providers.find((p) => p.id === 'groq')?.keySaved).toBe(false)
    const serialized = JSON.stringify(providers)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('sk-super')
  })
})

describe('KIEO-064 onboarding flag (unseen by default)', () => {
  it('absent means first launch; marking persists', () => {
    const db = tempDb()
    expect(hasSeenOnboarding(db)).toBe(false)
    markOnboardingSeen(db)
    expect(hasSeenOnboarding(db)).toBe(true)
  })
})

describe('KIEO-053 TTS mute', () => {
  it('enabled by default, toggles and persists', () => {
    const db = tempDb()
    expect(isTtsEnabled(db)).toBe(true)
    expect(setTtsEnabled(db, false)).toBe(false)
    expect(isTtsEnabled(db)).toBe(false)
    expect(setTtsEnabled(db, true)).toBe(true)
  })
})
