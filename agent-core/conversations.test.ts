// agent-core/conversations.test.ts — KIEO-040 acceptance coverage (pnpm test).
//
// Persists through the real SQLite helpers in isolated temp files: every
// turn lands as user/tool/assistant rows with correct roles, tool_call_json
// rides alongside, history reloads for the loop, and rows survive a close +
// reopen (restart). No Electron, no network.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../db/database'
import {
  getConversation,
  listConversations,
  listMessagesByConversation
} from '../db/tables'
import {
  appendAssistantMessage,
  appendToolMessage,
  appendUserMessage,
  ensureConversation,
  finalizeAssistantMessage,
  generateConversationTitle,
  loadHistoryModelMessages,
  messageRowToModelMessage
} from './conversations'

let dirs: string[] = []
let dbPaths: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  dbPaths = []
})

function tempDb(): { db: DatabaseHandle; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-conv-'))
  dirs.push(dir)
  const dbPath = join(dir, 'test.sqlite')
  dbPaths.push(dbPath)
  const db = getDatabase(dbPath)
  runMigrations(db)
  return { db, dbPath }
}

describe('KIEO-040 conversation titles + ensure', () => {
  it('generates a 60-char trimmed title, Untitled fallback', () => {
    expect(generateConversationTitle('  hello   world  ')).toBe('hello world')
    expect(generateConversationTitle('   ')).toBe('Untitled')
    expect(generateConversationTitle('')).toBe('Untitled')
    expect(generateConversationTitle('x'.repeat(100))).toHaveLength(60)
  })

  it('ensure reuses an existing id, creates fresh for unknown/missing', () => {
    const { db } = tempDb()
    const first = ensureConversation(db, { title: 'first' })
    expect(getConversation(db, first.id)?.title).toBe('first')

    const reused = ensureConversation(db, { conversationId: first.id, title: 'ignored' })
    expect(reused.id).toBe(first.id)
    expect(reused.title).toBe('first')

    const fresh = ensureConversation(db, { conversationId: 'no-such-id', title: 'second' })
    expect(fresh.id).not.toBe('no-such-id')
    expect(getConversation(db, fresh.id)?.title).toBe('second')
    expect(listConversations(db)).toHaveLength(2)
  })
})

describe('KIEO-040 turn persistence (roles + tool_call_json)', () => {
  it('stores user/assistant with correct roles and no tool_call_json when plain', () => {
    const { db } = tempDb()
    const conv = ensureConversation(db, { title: 't' })
    const user = appendUserMessage(db, conv.id, 'delete file x')
    const assistant = appendAssistantMessage(db, conv.id, 'done')

    expect(user.role).toBe('user')
    expect(user.tool_call_json).toBeNull()
    expect(assistant.role).toBe('assistant')
    expect(assistant.tool_call_json).toBeNull()

    const rows = listMessagesByConversation(db, conv.id)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(rows[0].content).toBe('delete file x')
    expect(rows[1].content).toBe('done')
  })

  it('stores tool_call_json alongside the assistant + per-tool rows (AC3)', () => {
    const { db } = tempDb()
    const conv = ensureConversation(db, { title: 't' })
    appendUserMessage(db, conv.id, 'read a then delete b')
    const calls = [
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' } },
      { toolCallId: 'c2', toolName: 'delete_file', input: { path: 'b.txt' } }
    ]
    const assistant = appendAssistantMessage(db, conv.id, 'Both done.', calls)
    expect(JSON.parse(assistant.tool_call_json as string)).toEqual(calls)

    const toolRow = appendToolMessage(
      db,
      conv.id,
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' } },
      { ok: true, content: 'hello' }
    )
    expect(toolRow.role).toBe('tool')
    expect(JSON.parse(toolRow.tool_call_json as string)).toMatchObject({
      toolCallId: 'c1',
      toolName: 'read_file'
    })

    // Insertion order survives same-millisecond created_at (rowid tie-break).
    const rows = listMessagesByConversation(db, conv.id)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('loads history as ModelMessages with reconstructed tool results', () => {
    const { db } = tempDb()
    const conv = ensureConversation(db, { title: 't' })
    appendUserMessage(db, conv.id, 'what is in a?')
    appendToolMessage(
      db,
      conv.id,
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' } },
      { ok: true }
    )
    appendAssistantMessage(db, conv.id, 'a contains hello')

    const history = loadHistoryModelMessages(db, conv.id)
    expect(history.map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(history[0]).toMatchObject({ role: 'user', content: 'what is in a?' })
    expect(history[2]).toMatchObject({ role: 'assistant', content: 'a contains hello' })

    const toolMsg = history[1] as unknown as {
      role: string
      content: Array<{ type: string; toolCallId: string; toolName: string; output: unknown }>
    }
    expect(toolMsg.content[0].type).toBe('tool-result')
    expect(toolMsg.content[0].toolCallId).toBe('c1')
    expect(toolMsg.content[0].toolName).toBe('read_file')
  })

  it('supports multi-turn continuation in one conversation', () => {
    const { db } = tempDb()
    const conv = ensureConversation(db, { title: 'chat' })
    appendUserMessage(db, conv.id, 'first')
    appendAssistantMessage(db, conv.id, 'first answer')
    // Second turn continues the same conversation id.
    const same = ensureConversation(db, { conversationId: conv.id })
    appendUserMessage(db, same.id, 'second')
    appendAssistantMessage(db, same.id, 'second answer')

    const history = loadHistoryModelMessages(db, conv.id)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(history[0]).toMatchObject({ content: 'first' })
    expect(history[2]).toMatchObject({ content: 'second' })
  })

  it('history survives close + reopen (restart, AC1)', () => {
    const { db, dbPath } = tempDb()
    const conv = ensureConversation(db, { title: 'persist me' })
    appendUserMessage(db, conv.id, 'remember this')
    appendAssistantMessage(db, conv.id, 'remembered')
    const convId = conv.id

    closeDatabase(dbPath)
    const reopened = getDatabase(dbPath)
    runMigrations(reopened)

    expect(getConversation(reopened, convId)?.title).toBe('persist me')
    const rows = listMessagesByConversation(reopened, convId)
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'remember this'],
      ['assistant', 'remembered']
    ])
    expect(loadHistoryModelMessages(reopened, convId)).toHaveLength(2)
  })

  it('finalized assistant sorts after per-turn tool rows (user -> tools -> assistant)', async () => {
    const { db } = tempDb()
    const conv = ensureConversation(db, { title: 't' })
    appendUserMessage(db, conv.id, 'do things')
    const placeholder = appendAssistantMessage(db, conv.id, '')
    appendToolMessage(
      db,
      conv.id,
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' } },
      { ok: true }
    )
    // Ensure a later millisecond so the re-stamp actually moves the row.
    await new Promise((r) => setTimeout(r, 2))
    finalizeAssistantMessage(db, conv.id, placeholder.id, 'all done', [
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' } }
    ])

    const rows = listMessagesByConversation(db, conv.id)
    expect(rows.map((r) => r.role)).toEqual(['user', 'tool', 'assistant'])
    expect(rows[2].content).toBe('all done')
    expect(JSON.parse(rows[2].tool_call_json as string)).toEqual([
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' } }
    ])
    const history = loadHistoryModelMessages(db, conv.id)
    expect(history.map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
  })

  it('tool row conversion never drops history on corrupt payloads', () => {
    const { db } = tempDb()
    const conv = ensureConversation(db, { title: 't' })
    const plain = appendToolMessage(
      db,
      conv.id,
      { toolCallId: 'c9', toolName: 'read_file', input: {} },
      'plain text result'
    )
    const msg = messageRowToModelMessage(plain)
    expect(msg).toMatchObject({ role: 'tool' })
    const content = (msg as unknown as { content: Array<{ output: { type: string; value: string } }> })
      .content[0]
    expect(content.output).toMatchObject({ type: 'text', value: 'plain text result' })
  })
})
