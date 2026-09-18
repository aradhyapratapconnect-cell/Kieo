// electron/ipc/activity.ts — Activity/Dashboard IPC bridge (KIEO-042).
//
// Single invoke channel reading straight from tool_execution_log, the source
// of truth per the Technical Architecture doc. Filters are validated through
// the shared normalizeToolLogsFilter() so a malformed renderer payload can
// never break the SQL layer. Live updates are push: agent.ts broadcasts
// 'tool-logs-updated' after every executed tool (see agentState.ts).
import { ipcMain } from 'electron'
import { getDatabase } from '../../db/database'
import { listToolLogs } from '../../db/tables'
import { normalizeToolLogsFilter } from '../../shared/types'

export function registerActivityIpc(): void {
  ipcMain.handle(
    'tool-logs-list',
    async (_event, payload?: {
      classification?: unknown
      approvalStatus?: unknown
      limit?: unknown
    }) => {
      const db = getDatabase()
      const filter = normalizeToolLogsFilter(
        (payload ?? {}) as Parameters<typeof normalizeToolLogsFilter>[0]
      )
      return listToolLogs(db, filter)
    }
  )
}
