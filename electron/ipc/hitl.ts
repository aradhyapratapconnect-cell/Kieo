// electron/ipc/hitl.ts — HITL approval request/response IPC channel (KIEO-001 stub).
// Real implementation (executeToolWithHITL dispatch + 60s timeout) lands in KIEO-013.
import { ipcMain } from 'electron'

export function registerHitlIpc(): void {
  // Placeholder handler so the channel exists; no approval logic yet.
  ipcMain.on('hitl-response', (_event, _payload) => {
    // TODO(KIEO-013): resolve the pending approval promise here.
  })
}
