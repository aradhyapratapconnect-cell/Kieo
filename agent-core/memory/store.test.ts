// agent-core/memory/store.test.ts — KIEO-041 store coverage.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { createConversation, createMessage, getMemoryFact, listMemoryFacts } from '../../db/tables'
import { buildMemoryContext, editFact, learnFacts, listFacts, removeFact } from './store'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-mem-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-041 memory store', () => {
  it('captures a stated durable fact (ticket AC1)', () => {
    const db = tempDb()
    const conv = createConversation(db, { title: 't' })
    const msg = createMessage(db, { conversationId: conv.id, role: 'user', content: 'I use pnpm' })
    const created = learnFacts(db, ['I use pnpm, not npm'], msg.id)
    expect(created).toHaveLength(1)
    expect(created[0].fact).toBe('User uses pnpm, not npm')
    expect(created[0].source_message_id).toBe(msg.id)
    expect(listMemoryFacts(db)).toHaveLength(1)
  })

  it('ignores commands and chatter (learns nothing)', () => {
    const db = tempDb()
    expect(learnFacts(db, ['delete file x'], null)).toEqual([])
    expect(learnFacts(db, ['what time is it?'], null)).toEqual([])
    expect(learnFacts(db, [''], null)).toEqual([])
    expect(listMemoryFacts(db)).toHaveLength(0)
  })

  it('dedupes case-insensitively within batch and against the DB', () => {
    const db = tempDb()
    expect(learnFacts(db, ['I use pnpm. i USE pnpm!'], null)).toHaveLength(1)
    expect(learnFacts(db, ['I USE PNPM, NOT NPM'], null)).toHaveLength(1)
    expect(learnFacts(db, ['I use pnpm, not npm'], null)).toHaveLength(0)
    expect(listMemoryFacts(db)).toHaveLength(2)
  })

  it('edit sets edited_by_user; delete removes the row', () => {
    const db = tempDb()
    const [row] = learnFacts(db, ['I use pnpm'], null)
    expect(row.edited_by_user).toBe(0)
    expect(editFact(db, row.id, '  User uses pnpm exclusively  ')).toBe(true)
    const edited = getMemoryFact(db, row.id)
    expect(edited?.fact).toBe('User uses pnpm exclusively')
    expect(edited?.edited_by_user).toBe(1)
    expect(editFact(db, row.id, '   ')).toBe(false)
    expect(removeFact(db, row.id)).toBe(true)
    expect(removeFact(db, row.id)).toBe(false)
    expect(listFacts(db)).toHaveLength(0)
  })

  it('deleted facts never reach LLM context (ticket AC3)', () => {
    const db = tempDb()
    expect(buildMemoryContext(db)).toBe('')
    const [row] = learnFacts(db, ['I use pnpm, not npm'], null)
    const ctx = buildMemoryContext(db)
    expect(ctx).toContain('User uses pnpm, not npm')
    expect(removeFact(db, row.id)).toBe(true)
    expect(buildMemoryContext(db)).toBe('')
  })

  it('context is empty with no facts and capped with many', () => {
    const db = tempDb()
    expect(buildMemoryContext(db)).toBe('')
    for (let i = 0; i < 30; i++) {
      learnFacts(db, [`My project${i} is Apollo${i}`], null)
    }
    const ctx = buildMemoryContext(db, 5)
    expect(ctx.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5)
  })
})
