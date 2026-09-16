// agent-core/conversations.ts — Conversation persistence (KIEO-040).
//
// Persists every turn to `conversations`/`messages` as the loop runs so
// history survives restarts. Electron-free (main process + unit tests).
//
// Storage contract (matches db/schema.sql + Technical Architecture §3):
//   * user      content = raw text, tool_call_json = null
//   * assistant content = final text (may be '' until the turn completes),
// //   *           tool_call_json = JSON array of {toolCallId, toolName, input}
//   *             for every tool call in the turn (AC3).
//   * tool      content = result payload (string as-is, else JSON-encoded),
//   *           tool_call_json = JSON {toolCallId, toolName, input} for the
//   *           single call it answers — enough to rebuild an AI SDK
//   *           tool-result message for the next turn's history.
//   * Every append bumps conversations.updated_at so listConversations()
//   * orders by recency (AC1).
//
// History loading returns AI SDK ModelMessage[] in chronological order for
// runAgentLoop({ history }). Text turns round-trip exactly; tool turns
// rebuild as { role:'tool', content:[{ type:'tool-result', ... }] }.
import type { ModelMessage } from 'ai'
import type { DatabaseHandle } from '../db/database'
import {
  createConversation,
  createMessage,
  getConversation,
  listMessagesByConversation,
  touchConversation,
  updateMessage,
  type ConversationRow,
  type MessageRow
} from '../db/tables'

export interface PersistedToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

export function generateConversationTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return 'Untitled'
  return collapsed.slice(0, 60) || 'Untitled'
}

/**
 * Get the target conversation for a turn: reuse when the id exists,
 * otherwise create a fresh one. A stale/unknown id never throws — it
 * starts a new conversation (the caller asked to continue something gone).
 */
export function ensureConversation(
  db: DatabaseHandle,
  opts: { conversationId?: string; title?: string } = {}
): ConversationRow {
  if (opts.conversationId) {
    const existing = getConversation(db, opts.conversationId)
    if (existing) return existing
  }
  return createConversation(db, { title: opts.title ?? 'Untitled' })
}

export function appendUserMessage(
  db: DatabaseHandle,
  conversationId: string,
  text: string
): MessageRow {
  const row = createMessage(db, {
    conversationId,
    role: 'user',
    content: text
  })
  touchConversation(db, conversationId)
  return row
}

export function appendAssistantMessage(
  db: DatabaseHandle,
  conversationId: string,
  text: string,
  toolCalls?: PersistedToolCall[] | null
): MessageRow {
  const row = createMessage(db, {
    conversationId,
    role: 'assistant',
    content: text,
    toolCallJson: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
  })
  touchConversation(db, conversationId)
  return row
}

export function appendToolMessage(
  db: DatabaseHandle,
  conversationId: string,
  call: PersistedToolCall,
  result: unknown
): MessageRow {
  const content = typeof result === 'string' ? result : JSON.stringify(result ?? null)
  const row = createMessage(db, {
    conversationId,
    role: 'tool',
    content,
    toolCallJson: JSON.stringify({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input
    })
  })
  touchConversation(db, conversationId)
  return row
}

/**
 * Finalize the turn's assistant placeholder with the loop's final text.
 * Re-stamps created_at so the row sorts AFTER any per-tool rows from the
 * same turn (user -> tools -> assistant) for both LLM history and the
 * future Conversations view. Also bumps the conversation recency.
 */
export function finalizeAssistantMessage(
  db: DatabaseHandle,
  conversationId: string,
  messageId: string,
  text: string,
  toolCalls?: PersistedToolCall[] | null
): boolean {
  const ok = updateMessage(db, messageId, {
    content: text,
    toolCallJson: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    createdAt: Date.now()
  })
  touchConversation(db, conversationId)
  return ok
}

/** Parse the single call stored on a tool row; null when absent/corrupt. */
function parseToolCallJson(raw: string | null): PersistedToolCall | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedToolCall>
    if (
      typeof parsed.toolCallId === 'string' &&
      typeof parsed.toolName === 'string' &&
      'input' in parsed
    ) {
      return { toolCallId: parsed.toolCallId, toolName: parsed.toolName, input: parsed.input }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Convert one DB row to an AI SDK message. Returns null only for rows with
 * an unrecognized role (never happens — CHECK constraint — but defensive).
 */
export function messageRowToModelMessage(row: MessageRow): ModelMessage | null {
  if (row.role === 'user') {
    return { role: 'user', content: row.content } as ModelMessage
  }
  if (row.role === 'assistant') {
    return { role: 'assistant', content: row.content } as ModelMessage
  }
  if (row.role === 'tool') {
    const call = parseToolCallJson(row.tool_call_json)
    // Best-effort result decode: JSON payloads become json output so the
    // next turn sees structured data; plain text stays text.
    let output: { type: 'text'; value: string } | { type: 'json'; value: unknown }
    const trimmed = row.content.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        output = { type: 'json', value: JSON.parse(row.content) as unknown }
      } catch {
        output = { type: 'text', value: row.content }
      }
    } else {
      output = { type: 'text', value: row.content }
    }
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: call?.toolCallId ?? `stored-${row.id}`,
          toolName: call?.toolName ?? 'unknown',
          output
        }
      ]
    } as unknown as ModelMessage
  }
  return null
}

/**
 * Load a conversation's history for the loop, oldest first. Skips rows that
 * fail conversion (defensive — none expected) rather than breaking the turn.
 */
export function loadHistoryModelMessages(
  db: DatabaseHandle,
  conversationId: string,
  limit = 500
): ModelMessage[] {
  const rows = listMessagesByConversation(db, conversationId, limit)
  const out: ModelMessage[] = []
  for (const row of rows) {
    const msg = messageRowToModelMessage(row)
    if (msg) out.push(msg)
  }
  return out
}
