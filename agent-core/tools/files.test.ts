// agent-core/tools/files.test.ts — KIEO-020 acceptance coverage (pnpm test).
//
// Implementation tests run against an isolated temp workspace (explicit root,
// no DB). Classification + approval routing are verified through the real
// registry and executeToolWithHITL.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { createConversation, createMessage, listToolLogs } from '../../db/tables'
import { executeToolWithHITL } from '../hitl'
import { toolRegistry } from './registry'
import {
  MAX_READ_CHARS,
  deleteFileTool,
  getWorkspaceRoot,
  readFileTool,
  resolveInWorkspace,
  writeFileTool,
  type FileToolOptions
} from './files'

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempWorkspace(): { root: string; opts: FileToolOptions } {
  const root = mkdtempSync(join(tmpdir(), 'kieo-files-'))
  dirs.push(root)
  return { root, opts: { workspaceRoot: root } }
}

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-files-db-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

describe('KIEO-020 workspace validation', () => {
  it('resolves inside paths and rejects escapes before any fs access', () => {
    const { root } = tempWorkspace()
    expect(resolveInWorkspace(root, 'a/b.txt').absolutePath).toBe(join(root, 'a', 'b.txt'))
    expect(resolveInWorkspace(root, './x.txt').absolutePath).toBe(join(root, 'x.txt'))
    // A file literally named "..data.txt" is NOT an escape.
    expect(resolveInWorkspace(root, '..data.txt').absolutePath).toBe(join(root, '..data.txt'))

    const escapes = [
      '../../etc/passwd',
      '..\\..\\Windows\\System32\\x',
      'sub/../../../outside.txt',
      '/etc/passwd',
      'C:\\Windows\\System32\\x.dll'
    ]
    for (const bad of escapes) {
      expect(() => resolveInWorkspace(root, bad)).toThrow(/escapes the permitted workspace/)
    }
    expect(() => resolveInWorkspace(root, '')).toThrow(/required/)
    expect(() => resolveInWorkspace(root, '..')).toThrow()
    expect(() => resolveInWorkspace(root, '.')).toThrow()
  })

  it('resolves the root from override, settings, then home', async () => {
    const { root, opts } = tempWorkspace()
    expect(getWorkspaceRoot(opts)).toBe(root)
    const db = tempDb()
    const { homedir } = await import('node:os')
    expect(getWorkspaceRoot({ db })).toBe(homedir())
    const { setSetting } = await import('../../db/tables')
    setSetting(db, 'workspace_root', root)
    expect(getWorkspaceRoot({ db })).toBe(root)
  })
})

describe('KIEO-020 read_file', () => {
  it('returns structured content with size, truncates huge files, refuses binary', async () => {
    const { root, opts } = tempWorkspace()
    await writeFile(join(root, 'a.txt'), 'hello kieo', 'utf8')
    const ok = await readFileTool({ path: 'a.txt' }, opts)
    expect(ok).toMatchObject({
      status: 'ok',
      path: join(root, 'a.txt'),
      sizeBytes: 10,
      content: 'hello kieo'
    })

    expect(await readFileTool({ path: 'missing.txt' }, opts)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/not found/i)
    })
    expect(await readFileTool({ path: '.' }, opts)).toMatchObject({ status: 'error' })

    await writeFile(join(root, 'bin.dat'), Buffer.from([0x48, 0x00, 0x49]))
    expect(await readFileTool({ path: 'bin.dat' }, opts)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/binary/i)
    })

    const big = 'x'.repeat(MAX_READ_CHARS + 100)
    await writeFile(join(root, 'big.txt'), big, 'utf8')
    const truncated = await readFileTool({ path: 'big.txt' }, opts)
    expect(truncated).toMatchObject({
      status: 'ok',
      truncated: true,
      totalChars: MAX_READ_CHARS + 100
    })
    if (truncated.status === 'ok') expect(truncated.content).toHaveLength(MAX_READ_CHARS)
  })

  it('rejects traversal without touching anything outside', async () => {
    const { opts } = tempWorkspace()
    const outside = join(tmpdir(), `kieo-canary-${Date.now()}.txt`)
    const res = await readFileTool({ path: '../'.repeat(8) + outside.slice(3) }, opts)
    expect(res.status).toBe('error')
    // And an absolute outside path is refused too.
    expect(await readFileTool({ path: outside }, opts)).toMatchObject({ status: 'error' })
  })
})

describe('KIEO-020 write_file', () => {
  it('creates and overwrites atomically, refuses missing parents', async () => {
    const { root, opts } = tempWorkspace()
    const created = await writeFileTool({ path: 'n.txt', content: 'one' }, opts)
    expect(created).toMatchObject({ status: 'ok', path: join(root, 'n.txt'), bytesWritten: 3 })
    expect(await readFile(join(root, 'n.txt'), 'utf8')).toBe('one')

    expect(await writeFileTool({ path: 'n.txt', content: 'two!' }, opts)).toMatchObject({
      status: 'ok',
      bytesWritten: 4
    })
    // No tmp leftovers beside the target.
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(root)).toEqual(['n.txt'])

    expect(
      await writeFileTool({ path: join('nope', 'n.txt'), content: 'x' }, opts)
    ).toMatchObject({ status: 'error', message: expect.stringMatching(/parent directory/i) })

    await mkdir(join(root, 'subdir'))
    expect(
      await writeFileTool({ path: 'subdir', content: 'x' }, opts)
    ).toMatchObject({ status: 'error', message: expect.stringMatching(/directory/i) })
  })

  it('traversal writes are rejected and nothing lands outside', async () => {
    const { root, opts } = tempWorkspace()
    const res = await writeFileTool({ path: '../../evil.txt', content: 'pwn' }, opts)
    expect(res).toMatchObject({ status: 'error' })
    expect(res).toMatchObject({ message: expect.stringMatching(/escapes/i) })
    await expect(stat(join(root, 'evil.txt')).catch(() => null)).resolves.toBeNull()
  })
})

describe('KIEO-020 delete_file', () => {
  it('deletes files, refuses directories and missing paths', async () => {
    const { root, opts } = tempWorkspace()
    await writeFile(join(root, 'gone.txt'), 'x', 'utf8')
    expect(await deleteFileTool({ path: 'gone.txt' }, opts)).toMatchObject({
      status: 'ok',
      path: join(root, 'gone.txt')
    })
    await expect(stat(join(root, 'gone.txt')).catch(() => null)).resolves.toBeNull()

    expect(await deleteFileTool({ path: 'gone.txt' }, opts)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/not found/i)
    })
    await mkdir(join(root, 'dir'))
    expect(await deleteFileTool({ path: 'dir' }, opts)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/directory/i)
    })
    await expect(stat(join(root, 'dir'))).resolves.toBeTruthy()
  })

  it('traversal deletes are rejected', async () => {
    const { root, opts } = tempWorkspace()
    const canary = join(tmpdir(), `kieo-keep-${Date.now()}.txt`)
    await writeFile(canary, 'keep me', 'utf8')
    dirs.push(canary)
    const rel = '..\\'.repeat(8) + canary
    expect(await deleteFileTool({ path: rel }, opts)).toMatchObject({ status: 'error' })
    expect(await readFile(canary, 'utf8')).toBe('keep me')
    void root
  })
})

describe('KIEO-020 classification + approval routing', () => {
  it('registry classifies read_file read_only, write/delete dangerous', () => {
    expect(toolRegistry.getTool('read_file')?.classification).toBe('read_only')
    expect(toolRegistry.getTool('write_file')?.classification).toBe('dangerous')
    expect(toolRegistry.getTool('delete_file')?.classification).toBe('dangerous')
  })

  it('read_file runs with no approval; delete_file denied leaves the file', async () => {
    const db = tempDb()
    const { opts } = tempWorkspace()
    const conv = createConversation(db, { title: 'files turn' })
    const messageId = createMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: ''
    }).id
    await writeFile(join(opts.workspaceRoot as string, 'note.txt'), 'secret sauce', 'utf8')

    let approvals = 0
    const base = {
      db,
      registry: toolRegistry,
      requestApproval: async () => {
        approvals += 1
        return 'denied' as const
      },
      executeTool: async (toolName: string, input: unknown) => {
        if (toolName === 'read_file') return readFileTool(input as { path: string }, opts)
        if (toolName === 'delete_file') return deleteFileTool(input as { path: string }, opts)
        throw new Error(`unexpected ${toolName}`)
      }
    }

    const read = await executeToolWithHITL(
      { toolCallId: 'f1', toolName: 'read_file', input: { path: 'note.txt' }, messageId },
      base
    )
    expect(read).toMatchObject({ status: 'auto_approved', executed: true })
    expect(read.result).toMatchObject({ status: 'ok', content: 'secret sauce' })
    expect(approvals).toBe(0)

    const denied = await executeToolWithHITL(
      { toolCallId: 'f2', toolName: 'delete_file', input: { path: 'note.txt' }, messageId },
      base
    )
    expect(denied).toMatchObject({ status: 'denied', executed: false })
    expect(approvals).toBe(1)
    expect(await readFile(join(opts.workspaceRoot as string, 'note.txt'), 'utf8')).toBe(
      'secret sauce'
    )
    // listToolLogs is newest-first.
    expect(listToolLogs(db).map((l) => l.approval_status)).toEqual([
      'denied',
      'auto_approved'
    ])
  })
})
