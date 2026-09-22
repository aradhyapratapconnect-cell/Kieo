// agent-core/autonomous.test.ts — KIEO-060 safety coverage (pnpm test).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../db/database'
import { applyAutonomy, AutonomousModelError, getAutonomousScope, isAutonomousEnabled, listAutonomousActions, setAutonomousEnabled, setAutonomousScope } from './autonomous'
import { toolRegistry } from './tools/registry'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  setAutonomousEnabled(false)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-auto-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-060 autonomous session flag (off by default)', () => {
  it('starts off and toggles explicitly', () => {
    expect(isAutonomousEnabled()).toBe(false)
    expect(setAutonomousEnabled(true)).toBe(true)
    expect(isAutonomousEnabled()).toBe(true)
    expect(setAutonomousEnabled(false)).toBe(false)
  })
})

describe('KIEO-060 scope (registry-validated, persisted)', () => {
  it('defaults to empty and round-trips sorted/deduped', () => {
    const db = tempDb()
    expect(getAutonomousScope(db)).toEqual([])
    expect(setAutonomousScope(db, toolRegistry, ['send_email', 'delete_file', 'delete_file'])).toEqual(
      ['delete_file', 'send_email']
    )
    expect(getAutonomousScope(db)).toEqual(['delete_file', 'send_email'])
  })

  it('rejects unknown action types', () => {
    const db = tempDb()
    expect(() => setAutonomousScope(db, toolRegistry, ['skynet'])).toThrowError(
      AutonomousModelError
    )
    expect(getAutonomousScope(db)).toEqual([])
  })

  it('lists every registry action with classification + scope flags', () => {
    const db = tempDb()
    setAutonomousScope(db, toolRegistry, ['delete_file'])
    const states = listAutonomousActions(db, toolRegistry)
    expect(states).toHaveLength(toolRegistry.listTools().length)
    expect(states.find((s) => s.actionType === 'delete_file')).toMatchObject({
      classification: 'dangerous',
      inScope: true
    })
    expect(states.find((s) => s.actionType === 'read_file')).toMatchObject({
      classification: 'read_only',
      inScope: false
    })
  })
})

describe('KIEO-060 policy composition (deny always wins)', () => {
  it('upgrades ask to allow only when armed and in scope', () => {
    expect(applyAutonomy('ask', true, true)).toBe('allow')
    expect(applyAutonomy('ask', false, true)).toBe('ask')
    expect(applyAutonomy('ask', true, false)).toBe('ask')
    expect(applyAutonomy('ask', false, false)).toBe('ask')
  })

  it('never overrides deny or duplicates allow', () => {
    expect(applyAutonomy('deny', true, true)).toBe('deny')
    expect(applyAutonomy('allow', false, false)).toBe('allow')
    expect(applyAutonomy('allow', true, true)).toBe('allow')
  })
})
