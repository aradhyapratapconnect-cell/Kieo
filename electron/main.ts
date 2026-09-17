// electron/main.ts — Electron main process entry point (KIEO-001).
// Owns app lifecycle, window creation, tray, and IPC registration.
// Renderer never gets direct Node/IPC access; see preload.ts.
import { app, BrowserWindow, session } from 'electron'
import { createMainWindow } from './windows'
import { registerTray } from './tray'
import { registerHitlIpc } from './ipc/hitl'
import { registerAgentIpc } from './ipc/agent'
import { registerMemoryIpc } from './ipc/memory'
import { registerSttIpc } from './ipc/stt'
import { registerSettingsIpc } from './ipc/settings'
import { setAgentWindow } from './ipc/agentState'
import { initDatabase } from '../db/database'
import { initKeyStore } from './secure/keyStore'

let mainWindow: BrowserWindow | null = null

async function onReady(): Promise<void> {
  // KIEO-030: Electron denies media capture by default — grant the request so
  // the OS-level mic dialog/permission decides. A denial surfaces in the
  // renderer as a clean text-only fallback (never a hang). Everything else
  // stays denied (least privilege); macOS also needs NSMicrophoneUsageDescription
  // at packaging time (noted for the packaging pass).
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === 'media')
    }
  );

  try {
    // KIEO-002: create <userData>/kieo.sqlite on first launch + migrate.
    initDatabase(app.getPath('userData'))
  } catch (err) {
    // Never crash startup on a DB failure; the error is loud in logs and
    // later tickets surface storage failures to the user per the error guide.
    console.error('[kieo] failed to initialize database:', err)
  }

  try {
    // KIEO-003: point the encrypted key store at <userData>/secure/keys.json.
    // Actual save/get happens on demand (Settings UI, KIEO-053); a missing
    // OS credential backend only fails then, with a clear error — never here.
    initKeyStore(app.getPath('userData'))
  } catch (err) {
    console.error('[kieo] failed to initialize key store:', err)
  }

  registerHitlIpc()
  registerAgentIpc()
  registerMemoryIpc()
  registerSttIpc()
  registerSettingsIpc()

  mainWindow = createMainWindow()
  setAgentWindow(mainWindow)
  registerTray(mainWindow)
}

void app.whenReady().then(onReady)

app.on('window-all-closed', () => {
  // Per Security doc: a pending AWAITING_APPROVAL action is discarded on quit,
  // never resumed or auto-approved on next launch. No pending-approval
  // persistence exists by design (see agent-core/hitl.ts in KIEO-013).
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow()
    setAgentWindow(mainWindow)
  }
})

