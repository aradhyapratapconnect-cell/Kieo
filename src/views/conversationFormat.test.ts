// src/views/conversationFormat.test.ts — KIEO-054 helper coverage.
import { describe, expect, it } from 'vitest'
import type { ConversationMessageDto } from '../../shared/types'
import { firstUserSnippet, headMessages } from './conversationFormat'

function msg(
  role: ConversationMessageDto['role'],
  content: string,
  id = Math.random().toString(36).slice(2)
): ConversationMessageDto {
  return {
    id,
    conversation_id: 'conv-1',
    role,
    content,
    tool_call_json: null,
    created_at: 1_700_000_000_000
  }
}

describe('KIEO-054 conversation preview helpers', () => {
  it('finds the first user message as a collapsed snippet', () => {
    expect(firstUserSnippet([])).toBeNull()
    expect(firstUserSnippet([msg('assistant', 'hi')])).toBeNull()
    expect(
      firstUserSnippet([msg('assistant', 'hi'), msg('user', '  delete\nfile x  ')])
    ).toBe('delete file x')
  })

  it('truncates long openers so modal rows stay compact', () => {
    const snippet = firstUserSnippet([msg('user', 'x'.repeat(500))])
    expect(snippet?.length).toBeLessThanOrEqual(141)
    expect(snippet?.endsWith('…')).toBe(true)
  })

  it('slices head windows without mutating', () => {
    const messages = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')]
    expect(headMessages(messages, 2)).toHaveLength(2)
    expect(headMessages(messages, 0)).toEqual([])
    expect(headMessages(messages, 99)).toHaveLength(3)
    expect(messages).toHaveLength(3)
  })
})
