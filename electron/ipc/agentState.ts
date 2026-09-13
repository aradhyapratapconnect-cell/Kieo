// electron/ipc/agentState.ts — main-window reference + agent-state broadcast.
//
// Shared by the agent bridge (KIEO-012: loop transitions -> Zustand store)
// and the HITL channel (KIEO-013: approval requests need a live window).
// Kept in its own module so electron/ipc/agent.ts and electron/ipc/hitl.ts
// can both use it without an import cycle.
import type { BrowserWindow } from 'electron'
import type { AgentState, TtsSpeakPayload } from '../../shared/types'

let agentWindow: BrowserWindow | null = null

export function setAgentWindow(win: BrowserWindow): void {
  agentWindow = win
}

export function getAgentWindow(): BrowserWindow | null {
  return agentWindow
}

/** Forward a loop state transition to the renderer store. Never throws. */
export function broadcastAgentState(state: AgentState): void {
  try {
    getAgentWindow()?.webContents.send('agent-state', state)
  } catch (err) {
    console.error('[kieo] failed to broadcast agent state:', err)
  }
}

/**
 * KIEO-031: deliver synthesized speech PCM for playback. Fire-and-forget by
 * nature (webContents.send) — playback never gates the loop or the text path.
 */
export function broadcastTtsSpeak(payload: TtsSpeakPayload): void {
  try {
    getAgentWindow()?.webContents.send('tts-speak', payload)
  } catch (err) {
    console.error('[kieo] failed to send speech audio:', err)
  }
}
