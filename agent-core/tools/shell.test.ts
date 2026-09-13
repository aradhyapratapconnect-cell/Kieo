// agent-core/tools/shell.test.ts — KIEO-021 acceptance coverage (pnpm test).
//
// Portable by design: every spawned command is the current Node binary
// (process.execPath) with -e scripts — no shell, no POSIX-only utilities.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { createConversation, createMessage } from '../../db/tables'
import { executeToolWithHITL } from '../hitl'
import { toolRegistry } from './registry'
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  executeShellTool,
  type ShellToolOptions
} from './shell'

const NODE = process.execPath

let dirs: string[] = []
let files: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  for (const f of files) rmSync(f, { force: true })
  files = []
})

function tempWorkspace(): { root: string; opts: ShellToolOptions } {
  const root = mkdtempSync(join(tmpdir(), 'kieo-shell-'))
  dirs.push(root)
  return { root, opts: { workspaceRoot: root } }
}

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-shell-db-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-021 spawn-only invocation', () => {
  it('runs via spawn(command, args[]) and captures stdout/stderr', async () => {
    const { root, opts } = tempWorkspace()
    const res = await executeShellTool(
      { command: NODE, args: ['-e', 'console.log("out"); console.error("err")'] },
      opts
    )
    expect(res).toMatchObject({
      status: 'ok',
      command: NODE,
      cwd: root,
      exitCode: 0,
      stdout: expect.stringContaining('out'),
      stderr: expect.stringContaining('err')
    })
    if (res.status === 'ok') expect(res.durationMs).toBeLessThan(10_000)
  })

  it('passes arguments verbatim — shell operators are inert data', async () => {
    const { opts } = tempWorkspace()
    const nasty = ['a b', 'x;y', '$(whoami)', '`id`', 'a|b', 'q"q']
    const res = await executeShellTool(
      { command: NODE, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...nasty] },
      opts
    )
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    // If a shell had interpreted these, the argv array would not survive.
    expect(JSON.parse(res.stdout.trim())).toEqual(nasty)
  })

  it('reports non-zero exits as error results with output attached', async () => {
    const { opts } = tempWorkspace()
    const res = await executeShellTool(
      { command: NODE, args: ['-e', 'console.error("boom"); process.exit(3)'] },
      opts
    )
    expect(res).toMatchObject({ status: 'error', exitCode: 3 })
    if (res.status !== 'error') return
    expect(res.stderr).toContain('boom')
    expect(res.message).toMatch(/exit(ed)? with code 3/)
  })

  it('missing executables are error results, never throws', async () => {
    const { opts } = tempWorkspace()
    const res = await executeShellTool(
      { command: 'definitely-not-a-real-binary-xyz', args: [] },
      opts
    )
    expect(res).toMatchObject({ status: 'error', exitCode: null })
    if (res.status !== 'error') return
    expect(res.message).toMatch(/not found/i)
  })

  it('rejects shell strings in command before spawning', async () => {
    const { opts } = tempWorkspace()
    for (const bad of [
      'echo hi; rm -rf /',
      'dir && echo pwned',
      'ls | grep x',
      'echo $(whoami)',
      'echo `id`',
      'a\nb'
    ]) {
      const res = await executeShellTool({ command: bad, args: [] }, opts)
      expect(res.status).toBe('error')
      if (res.status !== 'error') continue
      expect(res.message).toMatch(/shell string/i)
    }
  })

  it('this file uses no shell APIs — structural grep', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, 'shell.ts'), 'utf8')
    expect(source).toContain("from 'node:child_process'")
    expect(source).toContain('spawn(')
    // Strip comments first: the header documents the ban by naming the
    // forbidden APIs, so only executable code is checked.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
    for (const forbidden of [
      /\.exec\s*\(/,
      /execSync/,
      /spawnSync/,
      /shell\s*:\s*true/,
      /\beval\s*\(/
    ]) {
      expect(code).not.toMatch(forbidden)
    }
  })
})

describe('KIEO-021 whitelist + timeout', () => {
  it('runs in the workspace root by default, subdirs allowed, escapes rejected', async () => {
    const { root, opts } = tempWorkspace()
    await mkdir(join(root, 'sub'))
    const showCwd = ['-e', 'console.log(process.cwd())']

    const atRoot = await executeShellTool({ command: NODE, args: showCwd }, opts)
    expect(atRoot.status).toBe('ok')
    if (atRoot.status === 'ok') expect(atRoot.cwd).toBe(root)

    const inSub = await executeShellTool({ command: NODE, args: showCwd, cwd: 'sub' }, opts)
    expect(inSub.status).toBe('ok')
    if (inSub.status === 'ok') {
      expect(inSub.stdout.trim()).toBe(join(root, 'sub'))
    }

    const t0 = Date.now()
    for (const bad of ['..', '../..', '/etc', 'C:\\Windows', 'sub/../../..']) {
      const res = await executeShellTool({ command: NODE, args: showCwd, cwd: bad }, opts)
      expect(res.status).toBe('error')
      if (res.status !== 'error') continue
      expect(res.message).toMatch(/permitted workspace/i)
    }
    // Rejections happen before spawning — fast, no processes launched.
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('kills commands past the execution timeout and returns partial output', async () => {
    const { opts } = tempWorkspace()
    const t0 = Date.now()
    const res = await executeShellTool(
      { command: NODE, args: ['-e', 'console.log("partial"); setTimeout(() => {}, 30000)'] },
      { ...opts, timeoutMs: 400 }
    )
    const elapsed = Date.now() - t0
    expect(res).toMatchObject({ status: 'timeout' })
    if (res.status !== 'timeout') return
    expect(res.stdout).toContain('partial')
    expect(res.message).toMatch(/killed/i)
    expect(elapsed).toBeLessThan(15_000)
    expect(res.durationMs).toBeLessThan(15_000)
  })

  it('caps runaway output without deadlocking the child', async () => {
    const { opts } = tempWorkspace()
    const res = await executeShellTool(
      { command: NODE, args: ['-e', 'while (true) { console.log("x".repeat(100)) }'] },
      { ...opts, timeoutMs: 800, maxOutputChars: 1000 }
    )
    expect(res.status).toBe('timeout')
    if (res.status !== 'timeout') return
    expect(res.truncatedStdout).toBe(true)
    expect(res.stdout.length).toBeLessThanOrEqual(1000)
  })

  it('default timeout is 15s, separate from the 60s HITL clock', () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(15_000)
  })
})

describe('KIEO-021 classification + approval routing', () => {
  it('execute_shell is dangerous and runs only when approved', async () => {
    expect(toolRegistry.getTool('execute_shell')?.classification).toBe('dangerous')
    const db = tempDb()
    const { root, opts } = tempWorkspace()
    const conv = createConversation(db, { title: 'shell turn' })
    const messageId = createMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: ''
    }).id
    const canary = join(root, 'canary.txt')
    const marker = ['-e', `require("fs").writeFileSync(${JSON.stringify(canary)}, "x")`]

    const base = {
      db,
      registry: toolRegistry,
      executeTool: (toolName: string, input: unknown) =>
        executeShellTool(
          input as { command: string; args: string[] },
          opts
        ).then((r) => {
          if (toolName !== 'execute_shell') throw new Error('unexpected')
          return r
        })
    }

    const denied = await executeToolWithHITL(
      { toolCallId: 's1', toolName: 'execute_shell', input: { command: NODE, args: marker }, messageId },
      { ...base, requestApproval: async () => 'denied' as const }
    )
    expect(denied).toMatchObject({ status: 'denied', executed: false })
    await expect(stat(canary).catch(() => null)).resolves.toBeNull()

    const approved = await executeToolWithHITL(
      { toolCallId: 's2', toolName: 'execute_shell', input: { command: NODE, args: ['-e', 'console.log("ran")'] }, messageId },
      { ...base, requestApproval: async () => 'approved' as const }
    )
    expect(approved.status).toBe('approved')
    expect(approved.result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('ran') })
  })
})
