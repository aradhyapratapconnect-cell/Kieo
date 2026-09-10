// src/store/useAgentStore.ts — Zustand store (KIEO-001).
// Placeholder state; extended with conversation/messages/HITL state in later tickets.
import { create } from 'zustand'
import type { AgentState } from '../../shared/types'

interface AgentStore {
  agentState: AgentState
  setAgentState: (s: AgentState) => void
}

export const useAgentStore = create<AgentStore>((set) => ({
  agentState: 'IDLE',
  setAgentState: (agentState) => set({ agentState })
}))
