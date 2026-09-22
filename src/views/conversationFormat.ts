// src/views/conversationFormat.ts — pure Conversations helpers (KIEO-054).
//
// DOM/Electron-free so vitest covers them headlessly: identifying snippets
// for the preview modal and slicing message windows for display.
import type { ConversationMessageDto } from '../../shared/types'

export const PREVIEW_SNIPPET_CHARS = 140

/** First user message trimmed to a one-line snippet, or null when none. */
export function firstUserSnippet(messages: ConversationMessageDto[]): string | null {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return null
  const collapsed = first.content.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  return collapsed.length > PREVIEW_SNIPPET_CHARS
    ? `${collapsed.slice(0, PREVIEW_SNIPPET_CHARS)}…`
    : collapsed
}

/** First N messages in order (for the preview modal identification block). */
export function headMessages(
  messages: ConversationMessageDto[],
  limit: number
): ConversationMessageDto[] {
  if (limit <= 0) return []
  return messages.slice(0, limit)
}
