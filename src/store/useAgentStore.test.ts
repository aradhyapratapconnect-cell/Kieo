// src/store/useAgentStore.test.ts — KIEO-050 inline-response state.
import { describe, expect, it } from 'vitest'
import { useAgentStore } from './useAgentStore'

describe('KIEO-050 home inline response state', () => {
  it('holds the latest pushed turn until cleared', () => {
    const store = useAgentStore.getState()
    store.clearLastMessage()
    expect(useAgentStore.getState().lastMessage).toBeNull()

    store.setLastMessage({ conversationId: 'c1', text: 'Hello!', isError: false })
    expect(useAgentStore.getState().lastMessage).toMatchObject({
      conversationId: 'c1',
      text: 'Hello!',
      isError: false
    })

    store.setLastMessage({ conversationId: 'c1', text: 'Boom', isError: true })
    expect(useAgentStore.getState().lastMessage?.isError).toBe(true)

    store.clearLastMessage()
    expect(useAgentStore.getState().lastMessage).toBeNull()
  })
})
