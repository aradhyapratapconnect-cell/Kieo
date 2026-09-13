// src/store/useAgentStore.ts — Zustand store (KIEO-001, extended KIEO-032).
// Placeholder state; extended with conversation/messages/HITL state in later tickets.
import { create } from 'zustand'
import type { AgentState } from '../../shared/types'
import { isWakeEnabled } from '../voice/wakeword'

export type WakePhase = 'off' | 'spotting' | 'command'

interface AgentStore {
  agentState: AgentState
  setAgentState: (s: AgentState) => void
  /** KIEO-032: background wake-word listening (off by default). */
  wakeEnabled: boolean
  setWakeEnabled: (enabled: boolean) => void
  /** spotting = background; command = triggered, capturing the follow-up. */
  wakePhase: WakePhase
  setWakePhase: (phase: WakePhase) => void
  /** Latest wake notice/confirmation microcopy (null = nothing to show). */
  wakeNote: string | null
  setWakeNote: (note: string | null) => void
}

export const useAgentStore = create<AgentStore>((set) => ({
  agentState: 'IDLE',
  setAgentState: (agentState) => set({ agentState }),
  wakeEnabled: isWakeEnabled(),
  setWakeEnabled: (wakeEnabled) => set({ wakeEnabled }),
  wakePhase: 'off',
  setWakePhase: (wakePhase) => set({ wakePhase }),
  wakeNote: null,
  setWakeNote: (wakeNote) => set({ wakeNote })
}))
