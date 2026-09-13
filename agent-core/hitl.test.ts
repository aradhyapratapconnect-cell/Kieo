// agent-core/hitl.test.ts — KIEO-013 acceptance coverage (pnpm test).
//
// Pure-logic tests with a scripted RequestApproval (no Electron): the real
// IPC transport was additionally verified in Electron (pending map, timer,
// resolve matching, production DB logging) via a temporary self-test hook
// during KIEO-013, removed afterwards.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { DatabaseHandle } from '../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../db/database'
import {
  createConversation,
  createMessage,
  getMessage,
  listToolLogs
} from '../db/tables'
import { createToolRegistry } from './tools/registry'
import {
  HITL_DENIED_MESSAGE,
  createHitlExecutor,
  executeToolWithHITL,
  type ExecuteToolWithHitlDeps,
  type HitlApprovalRequest,
  type HitlDecision,
  type RequestApproval
} from './hitl'

const registry = createToolRegistry([
  {
    name: 'read_file',
    description: 'Read a file.',
    classification: 'read_only',
    inputShape: { path: z.string() }
  },
  {
    name: 'delete_file',
    description: 'Delete a file.',
    classification: 'dangerous',
    inputShape: { path: z.string() }
  }
])

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-hitl-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

function syntheticMessageId(db: DatabaseHandle): string {
  const conv = createConversation(db, { title: 'self-test turn' })
  return createMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: ''
  }).id
}

function scriptedApproval(
  decisions: HitlDecision[],
  seen: HitlApprovalRequest[] = []
): RequestApproval {
  let i = 0
  return async (req) => {
    seen.push(req)
    return decisions[Math.min(i++, decisions.length - 1)]
  }
}

function deps(
  db: DatabaseHandle,
  overrides: Partial<ExecuteToolWithHitlDeps> & {
    decisions?: HitlDecision[]
    seen?: HitlApprovalRequest[]
    executions?: Array<{ toolName: string; input: unknown }>
  } = {}
): ExecuteToolWithHitlDeps {
  const { decisions, seen, executions, ...rest } = overrides
  return {
    db,
    registry,
    requestApproval: scriptedApproval(decisions ?? ['approved'], seen),
    executeTool: async (toolName, input) => {
      executions?.push({ toolName, input })
      return { ok: true, tool: toolName }
    },
    timeoutMs: 2000,
    ...rest
  }
}

describe('KIEO-013 executeToolWithHITL', () => {
  it('approved dangerous tools execute once and log approved', async () => {
    const db = tempDb()
    const seen: HitlApprovalRequest[] = []
    const executions: Array<{ toolName: string; input: unknown }> = []
    const messageId = syntheticMessageId(db)
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'delete_file', input: { path: 'b.txt' }, messageId },
      deps(db, { decisions: ['approved'], seen, executions })
    )

    expect(outcome).toMatchObject({ status: 'approved', executed: true })
    expect(executions).toEqual([{ toolName: 'delete_file', input: { path: 'b.txt' } }])
    // The approval card receives the exact call, verbatim.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      toolCallId: 'c1',
      toolName: 'delete_file',
      input: { path: 'b.txt' },
      classification: 'dangerous',
      permissionActionType: 'delete_file'
    })
    const logs = listToolLogs(db)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      tool_name: 'delete_file',
      classification: 'dangerous',
      approval_status: 'approved'
    })
    expect(JSON.parse(logs[0].args_json)).toEqual({ path: 'b.txt' })
    expect(JSON.parse(logs[0].result_json as string)).toEqual({
      ok: true,
      tool: 'delete_file'
    })
  })

  it('denied tools never execute and log denied with a no-retry message', async () => {
    const db = tempDb()
    const executions: Array<{ toolName: string; input: unknown }> = []
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'delete_file', input: { path: 'b.txt' }, messageId: syntheticMessageId(db) },
      deps(db, { decisions: ['denied'], executions })
    )

    expect(outcome.executed).toBe(false)
    expect(outcome.status).toBe('denied')
    expect(outcome.result).toMatchObject({ status: 'denied', message: HITL_DENIED_MESSAGE })
    expect(executions).toHaveLength(0)
    expect(listToolLogs(db)[0].approval_status).toBe('denied')
  })

  it('timeouts never execute and log timeout with the configured duration', async () => {
    const db = tempDb()
    const executions: Array<{ toolName: string; input: unknown }> = []
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'delete_file', input: { path: 'b.txt' }, messageId: syntheticMessageId(db) },
      deps(db, { decisions: ['timeout'], executions, timeoutMs: 2000 })
    )

    expect(outcome.executed).toBe(false)
    expect(outcome.status).toBe('timeout')
    expect(outcome.result).toMatchObject({
      status: 'timeout',
      message: expect.stringContaining('2 seconds')
    })
    expect(executions).toHaveLength(0)
    expect(listToolLogs(db)[0].approval_status).toBe('timeout')
  })

  it('read-only tools skip approval entirely and log auto_approved', async () => {
    const db = tempDb()
    const seen: HitlApprovalRequest[] = []
    const executions: Array<{ toolName: string; input: unknown }> = []
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.txt' }, messageId: syntheticMessageId(db) },
      deps(db, { seen, executions })
    )

    expect(outcome).toMatchObject({ status: 'auto_approved', executed: true })
    expect(seen).toHaveLength(0)
    expect(executions).toEqual([{ toolName: 'read_file', input: { path: 'a.txt' } }])
    const logs = listToolLogs(db)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      classification: 'read_only',
      approval_status: 'auto_approved'
    })
  })

  it('unknown tools are denied without approval or execution', async () => {
    const db = tempDb()
    const seen: HitlApprovalRequest[] = []
    const executions: Array<{ toolName: string; input: unknown }> = []
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'rm_rf_everything', input: {}, messageId: syntheticMessageId(db) },
      deps(db, { seen, executions })
    )

    expect(outcome).toMatchObject({ status: 'denied', executed: false })
    expect(seen).toHaveLength(0)
    expect(executions).toHaveLength(0)
    expect(listToolLogs(db)[0]).toMatchObject({
      tool_name: 'rm_rf_everything',
      classification: 'dangerous',
      approval_status: 'denied'
    })
  })

  it('implementation errors become error results, never thrown crashes', async () => {
    const db = tempDb()
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'delete_file', input: { path: 'missing.txt' }, messageId: syntheticMessageId(db) },
      deps(db, {
        decisions: ['approved'],
        executeTool: async () => {
          throw new Error('ENOENT: no such file')
        }
      })
    )

    expect(outcome.status).toBe('approved')
    expect(outcome.executed).toBe(true)
    expect(outcome.result).toMatchObject({ status: 'error', message: 'ENOENT: no such file' })
    const logs = listToolLogs(db)
    expect(logs[0].approval_status).toBe('approved')
    expect(JSON.parse(logs[0].result_json as string).status).toBe('error')
  })

  it('policy seam: allow skips the card, deny skips execution (KIEO-014 preview)', async () => {
    const db = tempDb()
    const seen: HitlApprovalRequest[] = []
    const executions: Array<{ toolName: string; input: unknown }> = []
    const base = { seen, executions }

    const allowed = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'delete_file', input: { path: 'x' }, messageId: syntheticMessageId(db) },
      deps(db, { ...base, resolvePolicy: () => 'allow' })
    )
    expect(allowed).toMatchObject({ status: 'auto_approved', executed: true })

    const forbidden = await executeToolWithHITL(
      { toolCallId: 'c2', toolName: 'delete_file', input: { path: 'x' }, messageId: syntheticMessageId(db) },
      deps(db, { ...base, resolvePolicy: () => 'deny' })
    )
    expect(forbidden).toMatchObject({ status: 'denied', executed: false })
    expect(seen).toHaveLength(0)
    expect(executions).toHaveLength(1)
  })

  it('loop adapter returns the result and accumulates tool_call_json on the message', async () => {    const db = tempDb()
    const messageId = syntheticMessageId(db)
    const executor = createHitlExecutor({
      ...deps(db, { decisions: ['approved', 'approved'] }),
      messageId
    })

    const first = await executor(
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' } },
      { reportState: () => {} }
    )
    const second = await executor(
      { toolCallId: 'c2', toolName: 'read_file', input: { path: 'b' } },
      { reportState: () => {} }
    )
    expect(first).toEqual({ ok: true, tool: 'read_file' })
    expect(second).toEqual({ ok: true, tool: 'read_file' })

    const row = getMessage(db, messageId)
    expect(JSON.parse(row?.tool_call_json as string)).toEqual([
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' } },
      { toolCallId: 'c2', toolName: 'read_file', input: { path: 'b' } }
    ])
    expect(listToolLogs(db)).toHaveLength(2)
  })

  it('loop adapter reports AWAITING_APPROVAL around the approval gate (KIEO-033)', async () => {
    const db = tempDb()
    const messageId = syntheticMessageId(db)
    const states: string[] = []
    const executor = createHitlExecutor({
      ...deps(db, { decisions: ['approved'] }),
      messageId
    })
    await executor(
      { toolCallId: 'c1', toolName: 'delete_file', input: { path: 'x' } },
      {
        reportState: (s) => {
          states.push(s)
        }
      }
    )
    // Gate opens with AWAITING_APPROVAL, closes back to EXECUTING — the loop
    // and renderer observe both, so voice approval knows when to listen.
    expect(states).toEqual(['AWAITING_APPROVAL', 'EXECUTING'])
  })
})
