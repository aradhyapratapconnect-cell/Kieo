// src/store/useAgentStore.ts — Zustand store (KIEO-001, extended KIEO-032).
// KIEO-050 adds the home inline response: the latest finished turn pushed
// from main over 'agent-message' (text + error flag + conversation id).
import { create } from 'zustand'
import type { AgentMessageDto, AgentState } from '../../shared/types'
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
  /** KIEO-050: latest finished turn for the home inline response. */
  lastMessage: AgentMessageDto | null
  setLastMessage: (msg: AgentMessageDto) => void
  clearLastMessage: () => void
  /** KIEO-060: session autonomy armed (always false on launch). Drives the header badge. */
  autonomyEnabled: boolean
  setAutonomyEnabled: (enabled: boolean) => void
}

export const useAgentStore = create<AgentStore>((set) => ({
  agentState: 'IDLE',
  setAgentState: (agentState) => set({ agentState }),
  wakeEnabled: isWakeEnabled(),
  setWakeEnabled: (wakeEnabled) => set({ wakeEnabled }),
  wakePhase: 'off',
  setWakePhase: (wakePhase) => set({ wakePhase }),
  wakeNote: null,
  setWakeNote: (wakeNote) => set({ wakeNote }),
  lastMessage: null,
  setLastMessage: (lastMessage) => set({ lastMessage }),
  clearLastMessage: () => set({ lastMessage: null }),
  autonomyEnabled: false,
  setAutonomyEnabled: (autonomyEnabled) => set({ autonomyEnabled })
}))
