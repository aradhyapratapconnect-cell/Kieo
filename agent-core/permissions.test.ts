// agent-core/permissions.test.ts — KIEO-014 acceptance coverage (pnpm test).
//
// Policy resolution is verified against a real (temp) permissions table, and
// the end-to-end effect through executeToolWithHITL with the production
// resolver wired. Live revocation of a real pending IPC approval was
// additionally verified in Electron during KIEO-014 (temporary self-test
// hook, removed afterwards).
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
  listToolLogs,
  setPermission
} from '../db/tables'
import { createToolRegistry } from './tools/registry'
import {
  executeToolWithHITL,
  type HitlApprovalRequest,
  type HitlPolicyContext
} from './hitl'
import {
  findRevokedPendingApprovals,
  resolvePermissionPolicy
} from './permissions'

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
  const dir = mkdtempSync(join(tmpdir(), 'kieo-perm-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

function syntheticMessageId(db: DatabaseHandle): string {
  const conv = createConversation(db, { title: 'perm turn' })
  return createMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: ''
  }).id
}

const CTX: HitlPolicyContext = {
  toolName: 'delete_file',
  classification: 'dangerous',
  permissionActionType: 'delete_file'
}

describe('KIEO-014 permission enforcement', () => {
  it('defaults to ask, honors seeded ask_every_time, allow, and deny', () => {
    const db = tempDb()
    // Seeded by migration 001.
    expect(resolvePermissionPolicy(db, CTX)).toBe('ask')

    setPermission(db, 'delete_file', 'always_allow')
    expect(resolvePermissionPolicy(db, CTX)).toBe('allow')

    setPermission(db, 'delete_file', 'never_allow')
    expect(resolvePermissionPolicy(db, CTX)).toBe('deny')

    setPermission(db, 'delete_file', 'ask_every_time')
    expect(resolvePermissionPolicy(db, CTX)).toBe('ask')

    // Unlisted action types default to ask (never an open gate).
    expect(
      resolvePermissionPolicy(db, { ...CTX, permissionActionType: 'brand_new_tool' })
    ).toBe('ask')
  })

  it('a Settings change takes effect on the very next call, no restart', async () => {
    const db = tempDb()
    const messageId = syntheticMessageId(db)
    const seen: HitlApprovalRequest[] = []
    const executions: string[] = []
    const base = {
      db,
      registry,
      // eslint-disable-next-line @typescript-eslint/require-await
      requestApproval: async (req: HitlApprovalRequest) => {
        seen.push(req)
        return 'approved' as const
      },
      executeTool: async (toolName: string) => {
        executions.push(toolName)
        return { ok: true }
      },
      resolvePolicy: (ctx: typeof CTX) => resolvePermissionPolicy(db, ctx)
    }
    const call = (id: string) =>
      executeToolWithHITL(
        { toolCallId: id, toolName: 'delete_file', input: { path: 'x' }, messageId },
        base
      )

    // Default (ask_every_time): card shown, approved, executed.
    await call('c1')
    expect(seen).toHaveLength(1)
    expect(executions).toEqual(['delete_file'])

    // Flip to never_allow: immediate denial, card never shown.
    setPermission(db, 'delete_file', 'never_allow')
    const denied = await call('c2')
    expect(denied).toMatchObject({ status: 'denied', executed: false })
    expect(seen).toHaveLength(1)
    expect(executions).toHaveLength(1)

    // Flip to always_allow: executes with no card, still fully logged.
    setPermission(db, 'delete_file', 'always_allow')
    const allowed = await call('c3')
    expect(allowed).toMatchObject({ status: 'auto_approved', executed: true })
    expect(seen).toHaveLength(1)
    expect(executions).toHaveLength(2)
    const logs = listToolLogs(db)
    expect(logs.map((l) => l.approval_status)).toEqual([
      'auto_approved',
      'denied',
      'approved'
    ])
  })

  it('never_allow blocks even read-only tools (table cannot be bypassed)', async () => {
    const db = tempDb()
    const messageId = syntheticMessageId(db)
    let approvals = 0
    let executions = 0
    const base = {
      db,
      registry,
      // eslint-disable-next-line @typescript-eslint/require-await
      requestApproval: async () => {
        approvals += 1
        return 'approved' as const
      },
      executeTool: async () => {
        executions += 1
        return { ok: true }
      },
      resolvePolicy: (ctx: typeof CTX) => resolvePermissionPolicy(db, ctx)
    }
    setPermission(db, 'read_file', 'never_allow')
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'read_file', input: { path: 'a' }, messageId },
      { ...base, resolvePolicy: (ctx) => resolvePermissionPolicy(db, ctx) }
    )
    expect(outcome).toMatchObject({ status: 'denied', executed: false })
    expect(approvals).toBe(0)
    expect(executions).toBe(0)
    expect(listToolLogs(db)[0]).toMatchObject({
      classification: 'read_only',
      approval_status: 'denied'
    })
  })

  it('approval granted but revoked before execution is treated as denied', async () => {
    const db = tempDb()
    const messageId = syntheticMessageId(db)
    let executions = 0
    const outcome = await executeToolWithHITL(
      { toolCallId: 'c1', toolName: 'delete_file', input: { path: 'x' }, messageId },
      {
        db,
        registry,
        requestApproval: async () => {
          // Revoked while the card was open; approval arrives anyway.
          setPermission(db, 'delete_file', 'never_allow')
          return 'approved'
        },
        executeTool: async () => {
          executions += 1
          return { ok: true }
        },
        resolvePolicy: (ctx: typeof CTX) => resolvePermissionPolicy(db, ctx)
      }
    )
    expect(outcome).toMatchObject({ status: 'denied', executed: false })
    expect(outcome.result).toMatchObject({ status: 'denied' })
    expect(executions).toBe(0)
    expect(listToolLogs(db)[0].approval_status).toBe('denied')
  })

  it('findRevokedPendingApprovals flags only never_allow pendings', () => {
    const db = tempDb()
    setPermission(db, 'delete_file', 'never_allow')
    setPermission(db, 'send_email', 'always_allow')
    const revoked = findRevokedPendingApprovals(db, [
      { toolCallId: 'a', permissionActionType: 'delete_file' },
      { toolCallId: 'b', permissionActionType: 'send_email' },
      { toolCallId: 'c', permissionActionType: 'unlisted_tool' }
    ])
    expect(revoked).toEqual(['a'])
  })
})
