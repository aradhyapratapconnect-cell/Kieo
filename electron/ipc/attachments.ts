// electron/ipc/attachments.ts — drop-path validation (KIEO-063).
//
// Early UI feedback only: resolves each dropped path against the permitted
// workspace root (settings → home) and reports ok/rejected per path. The
// authoritative check stays inside the file/shell tools (KIEO-020/021),
// which re-validate immediately before touching disk.
import { ipcMain } from 'electron'
import { getWorkspaceRoot, resolveInWorkspace } from '../../agent-core/tools/files'

export function registerAttachmentsIpc(): void {
  ipcMain.handle('validate-paths', async (_event, payload: { paths?: unknown }) => {
    const inputs = Array.isArray(payload?.paths)
      ? payload.paths.filter((p): p is string => typeof p === 'string')
      : []
    const root = getWorkspaceRoot({})
    return inputs.slice(0, 25).map((input) => {
      try {
        const resolved = resolveInWorkspace(root, input)
        return { input, ok: true as const, resolved: resolved.absolutePath }
      } catch {
        return { input, ok: false as const, resolved: null }
      }
    })
  })
}
