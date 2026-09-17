// electron/ipc/memory.ts — Memory facts IPC bridge (KIEO-041).
//
// Read/write path for the Memory view (list/edit/delete). Learning itself
// happens in electron/ipc/agent.ts after each turn via learnFacts(); this
// module only serves the UI. All handlers are invoke (request/response) and
// return plain serializable DTOs.
import { ipcMain } from 'electron'
import { getDatabase } from '../../db/database'
import { editFact, listFacts, removeFact } from '../../agent-core/memory/store'

export function registerMemoryIpc(): void {
  ipcMain.handle('memory-list', async () => {
    const db = getDatabase()
    return listFacts(db)
  })

  ipcMain.handle(
    'memory-update',
    async (_event, payload: { id?: unknown; fact?: unknown }) => {
      if (typeof payload?.id !== 'string' || typeof payload?.fact !== 'string') {
        return { ok: false as const }
      }
      const db = getDatabase()
      const ok = editFact(db, payload.id, payload.fact)
      return { ok }
    }
  )

  ipcMain.handle(
    'memory-delete',
    async (_event, payload: { id?: unknown }) => {
      if (typeof payload?.id !== 'string') {
        return { ok: false as const }
      }
      const db = getDatabase()
      const ok = removeFact(db, payload.id)
      return { ok }
    }
  )
}
