// agent-core/tools/files.ts — read_file, write_file, delete_file (KIEO-020).
//
// All three resolve the requested path against the permitted workspace root
// and validate containment BEFORE touching disk: any `../` escape, absolute
// path outside the root, or symlink escape is refused with a structured
// error result (logged, fed back to the LLM — never a crash).
//
// Workspace root resolution (per call, so Settings changes apply at once):
//   explicit override (tests) -> `workspace_root` setting -> os.homedir().
// Classification lives in the registry (KIEO-011): read_file is read_only
// (no approval), write_file/delete_file are dangerous (approval via KIEO-013).
//
// Security notes:
//   * Writes are atomic (tmp + rename) and never create parent directories —
//     a missing parent is an error result, not an implicit mkdir.
//   * Deletes are files only: directories (and the final-component symlink
//     games around them) are refused.
//   * Reads cap output (truncation flagged) and refuse binary content and
//     oversized files, so a stray 2GB log can't blow up LLM context.
//   * Symlink escapes are closed with a realpath re-check after the lexical
//     check: a path lexically inside the root that resolves outside is denied.
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { DatabaseHandle } from '../../db/database'
import { getDatabase } from '../../db/database'
import { getSetting } from '../../db/tables'
import type { ToolDispatcher } from './dispatch'

export const SETTING_WORKSPACE_ROOT = 'workspace_root'

/** Display cap for read content (characters); larger files set truncated. */
export const MAX_READ_CHARS = 100_000
/** Hard refusal threshold for reads (bytes) — stat first, never read past it. */
export const MAX_READ_BYTES = 10 * 1024 * 1024

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspacePathError'
  }
}

export interface FileToolOptions {
  /** Test/override seam. Production resolves per call (settings -> home). */
  db?: DatabaseHandle
  /** Explicit root, bypassing settings (tests). Must exist. */
  workspaceRoot?: string
}

export interface ResolvedFilePath {
  /** Absolute, normalized path safe to touch. */
  absolutePath: string
  /** The workspace root it was validated against. */
  workspaceRoot: string
}

/** Resolve the permitted workspace root: override -> setting -> home dir. */
export function getWorkspaceRoot(opts: FileToolOptions = {}): string {
  if (opts.workspaceRoot) return resolve(opts.workspaceRoot)
  const db = opts.db ?? safeDefaultDatabase()
  const configured = db ? getSetting<string>(db, SETTING_WORKSPACE_ROOT) : null
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(configured.trim())
  }
  return homedir()
}

function safeDefaultDatabase(): DatabaseHandle | null {
  try {
    return getDatabase()
  } catch {
    // Uninitialized (unit tests without a DB): callers must pass workspaceRoot.
    return null
  }
}

/**
 * Resolve `inputPath` inside `workspaceRoot`, rejecting escapes BEFORE any
 * filesystem access. Throws WorkspacePathError on any violation.
 */
export function resolveInWorkspace(
  workspaceRoot: string,
  inputPath: string
): ResolvedFilePath {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new WorkspacePathError('A file path is required.')
  }
  if (inputPath.includes('\0')) {
    throw new WorkspacePathError('File paths cannot contain NUL bytes.')
  }
  const root = resolve(workspaceRoot)
  const absolutePath = resolve(root, inputPath)
  if (!isWithin(root, absolutePath)) {
    throw new WorkspacePathError(
      `Path escapes the permitted workspace (${root}): ${inputPath}`
    )
  }
  return { absolutePath, workspaceRoot: root }
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return false // the root itself is never a file target
  const rel = relative(root, candidate)
  // NOTE: a bare startsWith('..') would also reject innocent names like
  // '..data.txt' — only '..' segments escape.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  // Case-insensitive filesystems (Windows/macOS): compare case-insensitively
  // so `..\\..\\WINDOWS` can't dodge the check by case.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    const lowerRoot = root.toLowerCase()
    const lowerCand = candidate.toLowerCase()
    if (lowerCand !== lowerRoot && !lowerCand.startsWith(lowerRoot + sep)) {
      return false
    }
  }
  return true
}

/**
 * Post-open hardening: re-verify via realpath so a path that is lexically
 * inside the root but resolves outside (symlink escape) is still denied.
 * Touches only metadata (lstat/realpath), never file contents.
 */
async function assertNoSymlinkEscape(resolved: ResolvedFilePath): Promise<void> {
  const realRoot = await realpath(resolved.workspaceRoot)
  const parentReal = await realpath(dirname(resolved.absolutePath)).catch(() => null)
  if (parentReal === null) return // parent missing: impl returns its own error
  if (!isWithin(realRoot, parentReal) && parentReal !== realRoot) {
    throw new WorkspacePathError(
      `Path resolves outside the permitted workspace via symlink: ${resolved.absolutePath}`
    )
  }
  const st = await lstat(resolved.absolutePath).catch(() => null)
  if (st?.isSymbolicLink()) {
    const targetReal = await realpath(resolved.absolutePath)
    if (!isWithin(realRoot, targetReal)) {
      throw new WorkspacePathError(
        `Symlink target escapes the permitted workspace: ${resolved.absolutePath}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Results — structured, LLM-summarizable (ticket AC).
// ---------------------------------------------------------------------------

export type FileToolResult =
  | { status: 'ok'; path: string; bytesWritten?: number; sizeBytes?: number; content?: string; truncated?: boolean; totalChars?: number }
  | { status: 'error'; path?: string; message: string }

function toolError(message: string, path?: string): FileToolResult {
  return path ? { status: 'error', path, message } : { status: 'error', message }
}

function toErrorResult(err: unknown, path?: string): FileToolResult {
  if (err instanceof WorkspacePathError) return toolError(err.message, path)
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return toolError('File not found.', path)
  if (code === 'EACCES' || code === 'EPERM') return toolError('Permission denied by the OS.', path)
  if (code === 'EISDIR') return toolError('Path is a directory; this tool handles files only.', path)
  return toolError(err instanceof Error ? err.message : String(err), path)
}

// ---------------------------------------------------------------------------
// Implementations — each takes the raw tool input and options.
// ---------------------------------------------------------------------------

export async function readFileTool(
  input: { path: string },
  opts: FileToolOptions = {}
): Promise<FileToolResult> {
  const root = getWorkspaceRoot(opts)
  let resolved: ResolvedFilePath
  try {
    resolved = resolveInWorkspace(root, input.path)
    await assertNoSymlinkEscape(resolved)
    const st = await stat(resolved.absolutePath)
    if (!st.isFile()) {
      return toolError('Path is not a regular file.', resolved.absolutePath)
    }
    if (st.size > MAX_READ_BYTES) {
      return toolError(
        `File is ${(st.size / 1024 / 1024).toFixed(1)}MB — over the ${MAX_READ_BYTES / 1024 / 1024}MB read limit.`,
        resolved.absolutePath
      )
    }
    const buffer = await readFile(resolved.absolutePath)
    if (buffer.includes(0)) {
      return toolError(
        'File looks binary — refusing to dump it as text. Ask for a different approach (e.g. a targeted shell read).',
        resolved.absolutePath
      )
    }
    const text = buffer.toString('utf8')
    if (text.length > MAX_READ_CHARS) {
      return {
        status: 'ok',
        path: resolved.absolutePath,
        sizeBytes: st.size,
        content: text.slice(0, MAX_READ_CHARS),
        truncated: true,
        totalChars: text.length
      }
    }
    return { status: 'ok', path: resolved.absolutePath, sizeBytes: st.size, content: text }
  } catch (err) {
    return toErrorResult(err, typeof input?.path === 'string' ? input.path : undefined)
  }
}

export async function writeFileTool(
  input: { path: string; content: string },
  opts: FileToolOptions = {}
): Promise<FileToolResult> {
  const root = getWorkspaceRoot(opts)
  try {
    const resolved = resolveInWorkspace(root, input.path)
    await assertNoSymlinkEscape(resolved)
    if (typeof input.content !== 'string') {
      return toolError('Content must be a string.', resolved.absolutePath)
    }
    // Never create parent directories implicitly — fail loudly instead.
    const parentStat = await stat(dirname(resolved.absolutePath)).catch(() => null)
    if (!parentStat?.isDirectory()) {
      return toolError(
        'Parent directory does not exist — refusing to create directories implicitly.',
        resolved.absolutePath
      )
    }
    const existing = await lstat(resolved.absolutePath).catch(() => null)
    if (existing?.isDirectory()) {
      return toolError('Path is a directory; refusing to overwrite it.', resolved.absolutePath)
    }
    // Atomic write: tmp file in the OS temp dir, then rename over target.
    const tmpPath = join(
      tmpdir(),
      `kieo-write-${randomUUID()}.tmp`
    )
    await writeFile(tmpPath, input.content, 'utf8')
    await rename(tmpPath, resolved.absolutePath)
    const bytesWritten = Buffer.byteLength(input.content, 'utf8')
    return { status: 'ok', path: resolved.absolutePath, bytesWritten }
  } catch (err) {
    return toErrorResult(err, typeof input?.path === 'string' ? input.path : undefined)
  }
}

export async function deleteFileTool(
  input: { path: string },
  opts: FileToolOptions = {}
): Promise<FileToolResult> {
  const root = getWorkspaceRoot(opts)
  try {
    const resolved = resolveInWorkspace(root, input.path)
    await assertNoSymlinkEscape(resolved)
    const st = await lstat(resolved.absolutePath)
    if (!st.isFile()) {
      return toolError(
        st.isDirectory()
          ? 'Path is a directory; this tool deletes files only.'
          : 'Path is not a regular file (symlink, socket, or special file); refusing.',
        resolved.absolutePath
      )
    }
    await rm(resolved.absolutePath)
    return { status: 'ok', path: resolved.absolutePath }
  } catch (err) {
    return toErrorResult(err, typeof input?.path === 'string' ? input.path : undefined)
  }
}

// ---------------------------------------------------------------------------
// Registration into the implementation dispatcher (Epic C fills the rest).
// ---------------------------------------------------------------------------

export function registerFileTools(
  dispatcher: ToolDispatcher,
  opts: FileToolOptions = {}
): void {
  dispatcher.register('read_file', (input) =>
    readFileTool(input as { path: string }, opts)
  )
  dispatcher.register('write_file', (input) =>
    writeFileTool(input as { path: string; content: string }, opts)
  )
  dispatcher.register('delete_file', (input) =>
    deleteFileTool(input as { path: string }, opts)
  )
}
