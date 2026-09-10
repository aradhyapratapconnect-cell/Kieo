// electron/ipc/settings.ts — Settings IPC bridge (KIEO-001 stub).
// Backed by SQLite `settings` table in KIEO-002; UI lands in KIEO-053.
import { ipcMain } from 'electron'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings-get', async () => {
    // TODO(KIEO-002/KIEO-053): read from SQLite settings table.
    return {}
  })
  ipcMain.handle('settings-set', async (_event, _payload) => {
    // TODO(KIEO-002/KIEO-053): write to SQLite settings table.
    return { ok: true }
  })
}
