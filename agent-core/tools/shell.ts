// agent-core/tools/shell.ts — execute_shell (KIEO-021).
//
// SECURITY-CRITICAL INVARIANTS (also enforced by shell.test.ts, which greps
// this file for forbidden APIs):
//   * Invocation is ALWAYS child_process.spawn(command, args[]) with NO shell:
//     no exec-family calls, no spawnSync, no shell option, no eval. Arguments
//     reach the OS verbatim — shell operators inside them are inert data.
//   * The command itself must be a single executable reference: shell
//     operators, newlines, and command substitution in `command` are rejected
//     before spawning (defense in depth + clearer LLM feedback).
//   * Working directory is constrained to the workspace whitelist (the
//     workspace root by default, or a subdirectory of it via `cwd`).
//     Anything else is rejected BEFORE spawning.
//   * Every execution has an independent timeout (default 15s, separate from
//     the 60s HITL approval timeout): on expiry the process is killed
//     (SIGTERM, SIGKILL escalation) and a timeout result is returned.
//   * stdout/stderr stream-capture with per-stream caps (drained, never
//     blocking the child) so runaway output can't OOM the app or the LLM.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { getWorkspaceRoot, resolveInWorkspace, type FileToolOptions } from './files'
import type { ToolDispatcher } from './dispatch'

/** Execution timeout: independent of the HITL approval timeout (ticket AC). */
export const DEFAULT_EXEC_TIMEOUT_MS = 15_000
/** Per-stream output cap (chars); excess is drained and flagged truncated. */
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000
/** Grace period between SIGTERM and SIGKILL escalation. */
const KILL_GRACE_MS = 2_000

/** Shell operators/newlines have no meaning to spawn() — their presence means
 *  the caller built a shell string instead of (command, args). Reject loudly. */
const SHELL_STRING_PATTERN = /[;\n\r&|><`$()]/

export interface ShellToolOptions extends FileToolOptions {
  /** Override for tests. Production uses DEFAULT_EXEC_TIMEOUT_MS. */
  timeoutMs?: number
  /** Override for tests. Production uses DEFAULT_MAX_OUTPUT_CHARS. */
  maxOutputChars?: number
}

export interface ShellInput {
  command: string
  args?: string[]
  /** Optional working dir, resolved INSIDE the workspace root (default: root). */
  cwd?: string
}

export type ShellToolResult =
  | {
      status: 'ok'
      command: string
      args: string[]
      cwd: string
      exitCode: number
      stdout: string
      stderr: string
      durationMs: number
      truncatedStdout: boolean
      truncatedStderr: boolean
    }
  | {
      status: 'error'
      command: string
      args: string[]
      cwd: string
      exitCode: number | null
      stdout: string
      stderr: string
      durationMs: number
      truncatedStdout: boolean
      truncatedStderr: boolean
      message: string
    }
  | {
      status: 'timeout'
      command: string
      args: string[]
      cwd: string
      stdout: string
      stderr: string
      durationMs: number
      truncatedStdout: boolean
      truncatedStderr: boolean
      message: string
    }

function baseResult(input: { command: string; args: string[]; cwd: string }) {
  return {
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    stdout: '',
    stderr: '',
    durationMs: 0,
    truncatedStdout: false,
    truncatedStderr: false
  }
}

function validateInput(input: ShellInput): { command: string; args: string[] } {
  if (!input || typeof input.command !== 'string' || input.command.length === 0) {
    throw new Error('A command (executable name or path) is required.')
  }
  if (input.command.includes('\0')) {
    throw new Error('Command cannot contain NUL bytes.')
  }
  if (SHELL_STRING_PATTERN.test(input.command)) {
    throw new Error(
      `Command looks like a shell string ("${input.command.slice(0, 80)}"): pass a single executable as command with shell operators split into args — never pipes, redirects, &&, or $().`
    )
  }
  const args = input.args ?? []
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Error('args must be an array of strings.')
  }
  if (args.some((a) => a.includes('\0'))) {
    throw new Error('Arguments cannot contain NUL bytes.')
  }
  return { command: input.command, args }
}

export async function executeShellTool(
  input: ShellInput,
  opts: ShellToolOptions = {}
): Promise<ShellToolResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const startedAt = Date.now()

  let command: string
  let args: string[]
  try {
    ;({ command, args } = validateInput(input))
  } catch (err) {
    return {
      ...baseResult({
        command: String((input as ShellInput)?.command ?? ''),
        args: [],
        cwd: ''
      }),
      status: 'error',
      exitCode: null,
      message: err instanceof Error ? err.message : String(err)
    }
  }

  // Whitelist: cwd resolves inside the workspace root (default: the root
  // itself), or the call is rejected BEFORE spawning (ticket AC).
  const root = getWorkspaceRoot(opts)
  const rawCwd = input.cwd == null || input.cwd === '' ? '.' : input.cwd
  let cwd: string
  if (resolve(root, rawCwd) === resolve(root)) {
    cwd = resolve(root)
  } else {
    try {
      cwd = resolveInWorkspace(root, rawCwd).absolutePath
    } catch {
      return {
        ...baseResult({ command, args, cwd: '' }),
        status: 'error',
        exitCode: null,
        message:
          `Working directory escapes the permitted workspace (${root}). ` +
          `Shell commands run inside the workspace only.`
      }
    }
  }

  return new Promise<ShellToolResult>((resolvePromise) => {
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let truncatedStdout = false
    let truncatedStderr = false

    const finish = (result: ShellToolResult): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      clearTimeout(forceTimer)
      resolvePromise(result)
    }

    const shared = () => ({
      command,
      args,
      cwd,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      truncatedStdout,
      truncatedStderr
    })

    // The ONLY process-spawning call in this file: structured argv, no shell.
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    const killTimer = setTimeout(() => {
      if (settled) return
      timedOut = true
      child.kill()
      // Escalate if the process ignores SIGTERM (Windows: terminates anyway).
      forceTimer.refresh()
    }, timeoutMs)
    // Created up-front so finish() can always clear it; activated on timeout.
    const forceTimer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone — the close handler below will settle.
        }
      }
    }, timeoutMs + KILL_GRACE_MS)
    forceTimer.unref?.()
    // NOTE: killTimer stays referenced on purpose — it must fire even if it
    // is the last handle keeping the event loop alive.

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stdout.length < maxChars) {
        stdout += text.slice(0, maxChars - stdout.length)
        if (stdout.length >= maxChars) truncatedStdout = true
      } else {
        truncatedStdout = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stderr.length < maxChars) {
        stderr += text.slice(0, maxChars - stderr.length)
        if (stderr.length >= maxChars) truncatedStderr = true
      } else {
        truncatedStderr = true
      }
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      // Spawn failure (ENOENT, EACCES...): no process ever ran.
      const message =
        err.code === 'ENOENT'
          ? `Could not start "${command}": not found on PATH or not executable.`
          : `Could not start "${command}": ${err.message}`
      finish({ ...shared(), status: 'error', exitCode: null, message })
    })

    child.on('close', (code: number | null) => {
      if (timedOut) {
        finish({
          ...shared(),
          status: 'timeout',
          message: `Command ran longer than ${Math.round(timeoutMs / 1000)}s and was killed. Partial output above, if any.`
        })
        return
      }
      const exitCode = code ?? 0
      if (exitCode === 0) {
        finish({ ...shared(), status: 'ok', exitCode })
      } else {
        finish({
          ...shared(),
          status: 'error',
          exitCode,
          message: `Command exited with code ${exitCode}.`
        })
      }
    })
  })
}

export function registerShellTools(
  dispatcher: ToolDispatcher,
  opts: ShellToolOptions = {}
): void {
  dispatcher.register('execute_shell', (input) =>
    executeShellTool(input as ShellInput, opts)
  )
}
