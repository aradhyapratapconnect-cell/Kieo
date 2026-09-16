// db/tables.ts — CRUD helpers, one set per table (KIEO-002).
// Every function takes an explicit DatabaseHandle (no hidden globals), so the
// helpers are trivially testable and safe to call from main-process IPC
// handlers in later tickets. IDs default to UUIDs, timestamps to Date.now().
import { randomUUID } from 'node:crypto'
import type { DatabaseHandle } from './database'
import type {
  ApprovalStatus,
  PermissionLevel,
  ToolClassification
} from '../shared/types'

// ---------------------------------------------------------------------------
// Row types (mirror db/schema.sql)
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
}

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface MessageRow {
  id: string
  conversation_id: string
  role: MessageRole
  content: string
  tool_call_json: string | null
  created_at: number
}

export interface ToolLogRow {
  id: string
  message_id: string
  tool_name: string
  args_json: string
  classification: ToolClassification
  approval_status: ApprovalStatus
  result_json: string | null
  created_at: number
}

export interface MemoryFactRow {
  id: string
  fact: string
  source_message_id: string | null
  created_at: number
  edited_by_user: number
}

export interface PermissionRow {
  action_type: string
  level: PermissionLevel
  updated_at: number
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

export function createConversation(
  db: DatabaseHandle,
  input: { id?: string; title: string }
): ConversationRow {
  const id = input.id ?? randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(id, input.title, now, now)
  return getConversation(db, id) as ConversationRow
}

export function getConversation(
  db: DatabaseHandle,
  id: string
): ConversationRow | undefined {
  return db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined
}

export function listConversations(
  db: DatabaseHandle,
  limit = 100
): ConversationRow[] {
  return db
    .prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as ConversationRow[]
}

/** Returns true when a row was actually updated. */
export function updateConversationTitle(
  db: DatabaseHandle,
  id: string,
  title: string
): boolean {
  const info = db
    .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id)
  return info.changes > 0
}

/**
 * Bump a conversation's updated_at so recently-active chats sort first
 * (KIEO-040). Call after appending any message. Returns true when updated.
 */
export function touchConversation(db: DatabaseHandle, id: string): boolean {
  const info = db
    .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(Date.now(), id)
  return info.changes > 0
}

/** Returns true when a row was actually deleted (messages cascade). */
export function deleteConversation(db: DatabaseHandle, id: string): boolean {
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export function createMessage(
  db: DatabaseHandle,
  input: {
    id?: string
    conversationId: string
    role: MessageRole
    content: string
    toolCallJson?: string | null
  }
): MessageRow {
  const id = input.id ?? randomUUID()
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, role, content, tool_call_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.conversationId,
    input.role,
    input.content,
    input.toolCallJson ?? null,
    Date.now()
  )
  return getMessage(db, id) as MessageRow
}

export function getMessage(
  db: DatabaseHandle,
  id: string
): MessageRow | undefined {
  return db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(id) as MessageRow | undefined
}

export function listMessagesByConversation(
  db: DatabaseHandle,
  conversationId: string,
  limit = 500
): MessageRow[] {
  // KIEO-040: rowid tie-break keeps per-turn user/tool/assistant rows in
  // insertion order when several share the same created_at millisecond.
  return db
    .prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?'
    )
    .all(conversationId, limit) as MessageRow[]
}

export function deleteMessage(db: DatabaseHandle, id: string): boolean {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0
}

/**
 * Patch a message row (used by HITL dispatch to fill in the turn's assistant
 * message once the loop finishes). Returns true when a row was updated.
 *
 * KIEO-040: optional createdAt re-stamps the row so a finalized assistant
 * message sorts AFTER the per-tool rows created during the turn (user ->
 * tools -> assistant), instead of staying at its placeholder position.
 */
export function updateMessage(
  db: DatabaseHandle,
  id: string,
  patch: { content?: string; toolCallJson?: string | null; createdAt?: number }
): boolean {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) {
    sets.push('content = ?')
    params.push(patch.content)
  }
  if (patch.toolCallJson !== undefined) {
    sets.push('tool_call_json = ?')
    params.push(patch.toolCallJson)
  }
  if (patch.createdAt !== undefined) {
    sets.push('created_at = ?')
    params.push(patch.createdAt)
  }
  if (sets.length === 0) return false
  params.push(id)
  return (
    db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      .changes > 0
  )
}

// ---------------------------------------------------------------------------
// tool_execution_log — the source of truth for Activity/Dashboard (KIEO-042)
// ---------------------------------------------------------------------------

export function logToolExecution(
  db: DatabaseHandle,
  input: {
    id?: string
    messageId: string
    toolName: string
    args: unknown
    classification: ToolClassification
    approvalStatus: ApprovalStatus
    result?: unknown
  }
): ToolLogRow {
  const id = input.id ?? randomUUID()
  db.prepare(
    `INSERT INTO tool_execution_log
       (id, message_id, tool_name, args_json, classification, approval_status, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.messageId,
    input.toolName,
    JSON.stringify(input.args),
    input.classification,
    input.approvalStatus,
    input.result === undefined ? null : JSON.stringify(input.result),
    Date.now()
  )
  return getToolLog(db, id) as ToolLogRow
}

export function getToolLog(
  db: DatabaseHandle,
  id: string
): ToolLogRow | undefined {
  return db
    .prepare('SELECT * FROM tool_execution_log WHERE id = ?')
    .get(id) as ToolLogRow | undefined
}

export function listToolLogs(
  db: DatabaseHandle,
  filter: {
    classification?: ToolClassification
    approvalStatus?: ApprovalStatus
    limit?: number
  } = {}
): ToolLogRow[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.classification) {
    clauses.push('classification = ?')
    params.push(filter.classification)
  }
  if (filter.approvalStatus) {
    clauses.push('approval_status = ?')
    params.push(filter.approvalStatus)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(filter.limit ?? 200)
  return db
    .prepare(
      `SELECT * FROM tool_execution_log ${where} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params) as ToolLogRow[]
}

/** Attach (or overwrite) the result of an executed tool. Returns true when updated. */
export function updateToolLogResult(
  db: DatabaseHandle,
  id: string,
  result: unknown
): boolean {
  return (
    db
      .prepare('UPDATE tool_execution_log SET result_json = ? WHERE id = ?')
      .run(JSON.stringify(result), id).changes > 0
  )
}

// ---------------------------------------------------------------------------
// memory_facts (UI + extractor land in KIEO-041)
// ---------------------------------------------------------------------------

export function createMemoryFact(
  db: DatabaseHandle,
  input: { id?: string; fact: string; sourceMessageId?: string | null }
): MemoryFactRow {
  const id = input.id ?? randomUUID()
  db.prepare(
    `INSERT INTO memory_facts
       (id, fact, source_message_id, created_at, edited_by_user)
     VALUES (?, ?, ?, ?, 0)`
  ).run(id, input.fact, input.sourceMessageId ?? null, Date.now())
  return getMemoryFact(db, id) as MemoryFactRow
}

export function getMemoryFact(
  db: DatabaseHandle,
  id: string
): MemoryFactRow | undefined {
  return db
    .prepare('SELECT * FROM memory_facts WHERE id = ?')
    .get(id) as MemoryFactRow | undefined
}

export function listMemoryFacts(db: DatabaseHandle): MemoryFactRow[] {
  return db
    .prepare('SELECT * FROM memory_facts ORDER BY created_at ASC')
    .all() as MemoryFactRow[]
}

/**
 * User edit from the Memory view: replaces the fact and marks edited_by_user.
 * Returns true when a row was actually updated.
 */
export function updateMemoryFact(
  db: DatabaseHandle,
  id: string,
  fact: string
): boolean {
  return (
    db
      .prepare('UPDATE memory_facts SET fact = ?, edited_by_user = 1 WHERE id = ?')
      .run(fact, id).changes > 0
  )
}

export function deleteMemoryFact(db: DatabaseHandle, id: string): boolean {
  return db.prepare('DELETE FROM memory_facts WHERE id = ?').run(id).changes > 0
}

// ---------------------------------------------------------------------------
// permissions (enforcement lands in KIEO-014)
// ---------------------------------------------------------------------------

export function getPermission(
  db: DatabaseHandle,
  actionType: string
): PermissionRow | undefined {
  return db
    .prepare('SELECT * FROM permissions WHERE action_type = ?')
    .get(actionType) as PermissionRow | undefined
}

export function setPermission(
  db: DatabaseHandle,
  actionType: string,
  level: PermissionLevel
): PermissionRow {
  db.prepare(
    `INSERT INTO permissions (action_type, level, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (action_type) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`
  ).run(actionType, level, Date.now())
  return getPermission(db, actionType) as PermissionRow
}

export function listPermissions(db: DatabaseHandle): PermissionRow[] {
  return db
    .prepare('SELECT * FROM permissions ORDER BY action_type ASC')
    .all() as PermissionRow[]
}

// ---------------------------------------------------------------------------
// settings — values are JSON-encoded per the Technical Architecture doc
// ---------------------------------------------------------------------------

export function setSetting(db: DatabaseHandle, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value))
}

/** Returns the JSON-decoded value, or null when unset. */
export function getSetting<T>(db: DatabaseHandle, key: string): T | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as T
  } catch {
    return row.value as unknown as T
  }
}

export function deleteSetting(db: DatabaseHandle, key: string): boolean {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0
}
