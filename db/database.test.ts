// db/database.test.ts — KIEO-002 acceptance coverage (run: pnpm test).
// Each test uses an isolated temp-dir database file, never the real app data.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from './database'
import { closeDatabase, getDatabase, initDatabase, runMigrations } from './database'
import { MIGRATIONS } from './migrations'
import {
  createConversation,
  createMemoryFact,
  createMessage,
  deleteConversation,
  deleteMemoryFact,
  deleteSetting,
  getConversation,
  getPermission,
  getSetting,
  listConversations,
  listMemoryFacts,
  listMessagesByConversation,
  listPermissions,
  listToolLogs,
  logToolExecution,
  setPermission,
  setSetting,
  updateConversationTitle,
  updateMemoryFact
} from './tables'

let dirs: string[] = []

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-test-'))
  dirs.push(dir)
  return { dir, dbPath: join(dir, 'test.sqlite') }
}

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const EXPECTED_COLUMNS: Record<string, Array<{ name: string; type: string }>> = {
  conversations: [
    { name: 'id', type: 'TEXT' },
    { name: 'title', type: 'TEXT' },
    { name: 'created_at', type: 'INTEGER' },
    { name: 'updated_at', type: 'INTEGER' }
  ],
  messages: [
    { name: 'id', type: 'TEXT' },
    { name: 'conversation_id', type: 'TEXT' },
    { name: 'role', type: 'TEXT' },
    { name: 'content', type: 'TEXT' },
    { name: 'tool_call_json', type: 'TEXT' },
    { name: 'created_at', type: 'INTEGER' }
  ],
  tool_execution_log: [
    { name: 'id', type: 'TEXT' },
    { name: 'message_id', type: 'TEXT' },
    { name: 'tool_name', type: 'TEXT' },
    { name: 'args_json', type: 'TEXT' },
    { name: 'classification', type: 'TEXT' },
    { name: 'approval_status', type: 'TEXT' },
    { name: 'result_json', type: 'TEXT' },
    { name: 'created_at', type: 'INTEGER' }
  ],
  memory_facts: [
    { name: 'id', type: 'TEXT' },
    { name: 'fact', type: 'TEXT' },
    { name: 'source_message_id', type: 'TEXT' },
    { name: 'created_at', type: 'INTEGER' },
    { name: 'edited_by_user', type: 'INTEGER' }
  ],
  permissions: [
    { name: 'action_type', type: 'TEXT' },
    { name: 'level', type: 'TEXT' },
    { name: 'updated_at', type: 'INTEGER' }
  ],
  settings: [
    { name: 'key', type: 'TEXT' },
    { name: 'value', type: 'TEXT' }
  ]
}

function pragmaColumns(db: DatabaseHandle, table: string) {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
      type: string
    }>
  ).map((c) => ({ name: c.name, type: c.type }))
}

describe('KIEO-002 database', () => {
  it('creates the file on first use with all six tables and exact fields', () => {
    const { dbPath } = tempDbPath()
    expect(existsSync(dbPath)).toBe(false)
    const db = getDatabase(dbPath)
    runMigrations(db)
    expect(existsSync(dbPath)).toBe(true)
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      expect(pragmaColumns(db, table)).toEqual(columns)
    }
  })

  it('migration SQL covers every table in schema', () => {
    const sql = MIGRATIONS.map((m) => m.sql).join('\n')
    for (const table of Object.keys(EXPECTED_COLUMNS)) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`))
    }
  })

  it('runner is idempotent and seeds default permissions', () => {
    const { dbPath } = tempDbPath()
    const db = getDatabase(dbPath)
    expect(runMigrations(db)).toEqual([1])
    expect(runMigrations(db)).toEqual([])
    expect(runMigrations(db)).toEqual([])
    const perms = listPermissions(db)
    expect(perms.length).toBeGreaterThanOrEqual(7)
    expect(perms.find((p) => p.action_type === 'execute_shell')?.level).toBe(
      'ask_every_time'
    )
  })

  it('initDatabase creates kieo.sqlite inside the given app-data dir', () => {
    const { dir } = tempDbPath()
    initDatabase(dir)
    expect(existsSync(join(dir, 'kieo.sqlite'))).toBe(true)
    // Second init is a safe no-op.
    initDatabase(dir)
    expect(
      (getDatabase().prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n
    ).toBe(1)
  })

  it('conversations CRUD round-trips', () => {
    const { dbPath } = tempDbPath()
    const db = getDatabase(dbPath)
    runMigrations(db)
    const created = createConversation(db, { title: 'Hello' })
    expect(created.id).toBeTruthy()
    expect(getConversation(db, created.id)?.title).toBe('Hello')
    expect(listConversations(db).map((c) => c.id)).toContain(created.id)
    expect(updateConversationTitle(db, created.id, 'Renamed')).toBe(true)
    expect(getConversation(db, created.id)?.title).toBe('Renamed')
    expect(updateConversationTitle(db, 'missing', 'x')).toBe(false)
    expect(deleteConversation(db, created.id)).toBe(true)
    expect(getConversation(db, created.id)).toBeUndefined()
  })

  it('messages, tool logs and memory facts CRUD round-trip with FK cascade', () => {
    const { dbPath } = tempDbPath()
    const db = getDatabase(dbPath)
    runMigrations(db)
    const conv = createConversation(db, { title: 't' })
    const msg = createMessage(db, {
      conversationId: conv.id,
      role: 'user',
      content: 'delete file x'
    })
    expect(listMessagesByConversation(db, conv.id)).toHaveLength(1)

    const withToolCall = createMessage(db, {
      conversationId: conv.id,
      role: 'tool',
      content: 'result',
      toolCallJson: JSON.stringify({ name: 'delete_file' })
    })
    expect(withToolCall.tool_call_json).toContain('delete_file')

    const log = logToolExecution(db, {
      messageId: withToolCall.id,
      toolName: 'delete_file',
      args: { path: '/tmp/x' },
      classification: 'dangerous',
      approvalStatus: 'approved',
      result: { ok: true }
    })
    expect(JSON.parse(log.args_json)).toEqual({ path: '/tmp/x' })
    expect(listToolLogs(db, { classification: 'dangerous' })).toHaveLength(1)
    expect(listToolLogs(db, { classification: 'read_only' })).toHaveLength(0)
    expect(msg.id).toBeTruthy()

    const fact = createMemoryFact(db, {
      fact: 'uses pnpm',
      sourceMessageId: msg.id
    })
    expect(fact.edited_by_user).toBe(0)
    expect(updateMemoryFact(db, fact.id, 'uses pnpm exclusively')).toBe(true)
    const edited = listMemoryFacts(db)[0]
    expect(edited.fact).toBe('uses pnpm exclusively')
    expect(edited.edited_by_user).toBe(1)
    expect(deleteMemoryFact(db, fact.id)).toBe(true)

    // Deleting the conversation cascades to messages and their tool logs.
    expect(deleteConversation(db, conv.id)).toBe(true)
    expect(listMessagesByConversation(db, conv.id)).toHaveLength(0)
    expect(listToolLogs(db)).toHaveLength(0)
  })

  it('permissions and settings CRUD round-trip', () => {
    const { dbPath } = tempDbPath()
    const db = getDatabase(dbPath)
    runMigrations(db)
    expect(setPermission(db, 'execute_shell', 'never_allow').level).toBe(
      'never_allow'
    )
    expect(getPermission(db, 'execute_shell')?.level).toBe('never_allow')
    setSetting(db, 'wake_word', 'Hey Kieo')
    setSetting(db, 'providers', { active: 'openai' })
    expect(getSetting<string>(db, 'wake_word')).toBe('Hey Kieo')
    expect(getSetting<{ active: string }>(db, 'providers')).toEqual({
      active: 'openai'
    })
    expect(getSetting(db, 'missing')).toBeNull()
    expect(deleteSetting(db, 'wake_word')).toBe(true)
    expect(deleteSetting(db, 'wake_word')).toBe(false)
  })

  it('rejects invalid enum values and FK violations', () => {
    const { dbPath } = tempDbPath()
    const db = getDatabase(dbPath)
    runMigrations(db)
    const conv = createConversation(db, { title: 't' })
    expect(() =>
      createMessage(db, {
        conversationId: conv.id,
        // @ts-expect-error intentional invalid role
        role: 'system',
        content: 'x'
      })
    ).toThrow()
    expect(() =>
      createMessage(db, {
        conversationId: 'no-such-conversation',
        role: 'user',
        content: 'x'
      })
    ).toThrow()
    expect(() =>
      setPermission(
        db,
        'execute_shell',
        // @ts-expect-error intentional invalid level
        'sometimes'
      )
    ).toThrow()
  })
})
