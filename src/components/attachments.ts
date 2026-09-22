// src/components/attachments.ts — drag-and-drop attach helpers (KIEO-063).
//
// Attachments ride as a quoted block appended to the command text, so they
// flow through the existing sendCommand channel untouched (typed, voice, and
// wake-word paths all share it). Paths are validated twice: early in the UI
// via the `validate-paths` IPC (workspace whitelist, immediate feedback) and
// authoritatively inside every file/shell tool before touching disk
// (KIEO-020/021) — the UI check is convenience, never the security boundary.
import type { PathValidationDto } from '../../shared/types'

export const MAX_ATTACHMENTS = 5

export interface AttachedFile {
  /** Workspace-absolute path (validated) or the dropped name (invalid). */
  display: string
  /** Resolved absolute path, or null when rejected/unvalidated. */
  resolved: string | null
  ok: boolean
}

export function fromValidation(results: PathValidationDto[]): AttachedFile[] {
  return results.map((r) => ({
    display: r.resolved ?? r.input,
    resolved: r.ok ? (r.resolved ?? r.input) : null,
    ok: r.ok
  }))
}

/** Merge new drops in: dedupe by resolved path, cap at MAX_ATTACHMENTS. */
export function mergeAttachments(current: AttachedFile[], incoming: AttachedFile[]): AttachedFile[] {
  const seen = new Set(current.map((f) => f.resolved ?? f.display))
  const merged = [...current]
  for (const file of incoming) {
    const key = file.resolved ?? file.display
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(file)
    if (merged.length >= MAX_ATTACHMENTS) break
  }
  return merged
}

export function validAttachmentPaths(files: AttachedFile[]): string[] {
  return files.filter((f) => f.ok && f.resolved).map((f) => f.resolved as string)
}

/**
 * Append the attachment block to a command. Only validated paths are
 * included — rejected drops never reach the agent loop as context.
 */
export function formatCommandWithAttachments(text: string, files: AttachedFile[]): string {
  const paths = validAttachmentPaths(files)
  if (paths.length === 0) return text
  const block = paths.map((p) => `- ${p}`).join('\n')
  return `${text}\n\n[Attached files]\n${block}`
}
