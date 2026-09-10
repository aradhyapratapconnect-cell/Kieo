// electron/ipc/agent.ts — Renderer <-> agent core IPC bridge (KIEO-001 stub).
// Real wiring (runAgentLoop dispatch, streaming tokens) lands in KIEO-012.
import { ipcMain } from 'electron'

export function registerAgentIpc(): void {
  ipcMain.on('agent-command', (_event, _payload) => {
    // TODO(KIEO-012): forward to runAgentLoop() and stream results back.
  })
}
