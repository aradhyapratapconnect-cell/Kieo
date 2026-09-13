// electron/ipc/agent.ts — Renderer <-> agent core IPC bridge.
// KIEO-012: main->renderer agent-state broadcast, so loop transitions
// (IDLE/THINKING/AWAITING_APPROVAL/EXECUTING) surface in the Zustand store.
// Command dispatch ('agent-command' -> runAgentLoop) waits for KIEO-013, when
// executeToolWithHITL gives the loop a safe executor — dispatching earlier
// would leave tool calls with no approval path.
import { ipcMain, type BrowserWindow } from 'electron'
import type { AgentState } from '../../shared/types'

let agentWindow: BrowserWindow | null = null

export function setAgentWindow(win: BrowserWindow): void {
  agentWindow = win
}

/** Forward a loop state transition to the renderer store. Never throws. */
export function broadcastAgentState(state: AgentState): void {
  try {
    agentWindow?.webContents.send('agent-state', state)
  } catch (err) {
    console.error('[kieo] failed to broadcast agent state:', err)
  }
}

export function registerAgentIpc(): void {
  ipcMain.on('agent-command', (_event, _payload) => {
    // TODO(KIEO-013): forward to runAgentLoop() with executeToolWithHITL.
  })
}
