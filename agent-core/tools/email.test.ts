// agent-core/tools/email.test.ts — KIEO-023 acceptance coverage (pnpm test).
//
// Network-free: a fake SmtpSender stands in for nodemailer (capture/throw
// scripts); one offline smoke test drives the real nodemailer adapter
// against a refused localhost port to prove error mapping end to end.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/database'
import { closeDatabase, getDatabase, runMigrations } from '../../db/database'
import { createConversation, createMessage, setSetting } from '../../db/tables'
import type { KeyStore } from '../../electron/secure/keyStore'
import { executeToolWithHITL } from '../hitl'
import { toolRegistry } from './registry'
import {
  KEYSTORE_SMTP_PASSWORD,
  createSmtpTransport,
  draftEmailTool,
  sendEmailTool,
  type EmailInput,
  type EmailToolOptions,
  type SmtpSender
} from './email'

const PASSWORD = 's3cret-app-password'
const INPUT: EmailInput = {
  to: 'Ada@Example.COM',
  subject: '  Q3  review — ACTION needed  ',
  body: 'Hi Ada,\n\n  Please review.\n\nThanks!  \n'
}

let dirs: string[] = []

afterEach(() => {
  closeDatabase()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDb(): DatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), 'kieo-email-db-'))
  dirs.push(dir)
  const db = getDatabase(join(dir, 'test.sqlite'))
  runMigrations(db)
  return db
}

function fakeKeyStore(password: string | null): KeyStore {
  return {
    isAvailable: () => true,
    saveKey: () => {},
    getKey: (name) => (name === KEYSTORE_SMTP_PASSWORD ? password : null),
    deleteKey: () => false,
    listProviders: () => []
  }
}

function seedSmtp(db: DatabaseHandle): void {
  setSetting(db, 'smtp_host', 'mail.example.com')
  setSetting(db, 'smtp_port', 587)
  setSetting(db, 'smtp_secure', false)
  setSetting(db, 'smtp_user', 'kieo@example.com')
}

function captureTransport(): SmtpSender & {
  calls: Array<{ from: string; to: string; subject: string; text: string }>
} {
  const calls: Array<{ from: string; to: string; subject: string; text: string }> = []
  return {
    calls,
    sendMail: async (message) => {
      calls.push(message)
      return { messageId: 'test-id-1' }
    }
  }
}

function throwingTransport(err: unknown): SmtpSender {
  return {
    sendMail: async () => {
      throw err
    }
  }
}

function opts(
  db: DatabaseHandle,
  extra: Partial<EmailToolOptions> = {}
): EmailToolOptions {
  return { db, keyStore: fakeKeyStore(PASSWORD), ...extra }
}

describe('KIEO-023 draft_email', () => {
  it('returns the fields verbatim — no paraphrasing, no normalization', async () => {
    const res = await draftEmailTool(INPUT)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    // Byte-identical, including odd casing and padding whitespace.
    expect(res.draft).toEqual({ to: INPUT.to, subject: INPUT.subject, body: INPUT.body })
  })

  it('rejects malformed recipients without sending anything', async () => {
    for (const bad of ['not-an-email', '', 'a@b', '@x.com']) {
      const res = await draftEmailTool({ to: bad, subject: 's', body: 'b' })
      expect(res).toMatchObject({ status: 'error', code: 'validation' })
    }
  })
})

describe('KIEO-023 send_email exactness + config', () => {
  it('transmits recipient/subject/body byte-identical to the approved input', async () => {
    const db = tempDb()
    seedSmtp(db)
    const transport = captureTransport()
    const res = await sendEmailTool(INPUT, opts(db, { transport }))
    expect(res).toMatchObject({ status: 'ok', messageId: 'test-id-1', to: INPUT.to, subject: INPUT.subject })
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]).toEqual({
      from: 'kieo@example.com',
      to: INPUT.to,
      subject: INPUT.subject,
      text: INPUT.body
    })
  })

  it('missing host or password fails as config without touching the transport', async () => {
    const db = tempDb()
    const transport = captureTransport()
    // No settings at all.
    expect(await sendEmailTool(INPUT, opts(db, { transport }))).toMatchObject({
      status: 'error',
      code: 'config'
    })
    seedSmtp(db)
    // Configured host, but no password in the key store.
    const noPw = await sendEmailTool(INPUT, {
      db,
      keyStore: fakeKeyStore(null),
      transport
    })
    expect(noPw).toMatchObject({ status: 'error', code: 'config' })
    if (noPw.status === 'error') expect(noPw.message).toMatch(/password|keychain|Settings/i)
    expect(transport.calls).toHaveLength(0)
  })

  it('password never lands in settings, and never leaks into errors', async () => {
    const db = tempDb()
    seedSmtp(db)
    const transport = captureTransport()
    await sendEmailTool(INPUT, opts(db, { transport }))
    const rows = db.prepare('SELECT value FROM settings').all() as Array<{ value: string }>
    expect(rows.map((r) => r.value).join('\n')).not.toContain(PASSWORD)

    const leak = new Error(`Server says bad login with ${PASSWORD} try again`)
    ;(leak as NodeJS.ErrnoException).code = 'EAUTH'
    const res = await sendEmailTool(INPUT, opts(db, { transport: throwingTransport(leak) }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.message).not.toContain(PASSWORD)
    expect(res.message).toContain('[redacted]')
  })
})

describe('KIEO-023 send failures per the Error Handling Guide', () => {
  it('auth failure -> clear auth error', async () => {
    const db = tempDb()
    seedSmtp(db)
    const err = new Error('Invalid login: 535-5.7.8 Username and Password not accepted')
    ;(err as { responseCode?: number }).responseCode = 535
    const res = await sendEmailTool(INPUT, opts(db, { transport: throwingTransport(err) }))
    expect(res).toMatchObject({ status: 'error', code: 'auth' })
    if (res.status !== 'error') return
    expect(res.message).toMatch(/authentication failed|Settings/i)
  })

  it('bounce/rejection -> clear rejected error', async () => {
    const db = tempDb()
    seedSmtp(db)
    const err = new Error('550 5.1.1 The email account does not exist')
    ;(err as { responseCode?: number }).responseCode = 550
    const res = await sendEmailTool(INPUT, opts(db, { transport: throwingTransport(err) }))
    expect(res).toMatchObject({ status: 'error', code: 'rejected' })
    if (res.status !== 'error') return
    expect(res.message).toMatch(/refused|invalid/i)
  })

  it('unreachable host -> clear connection error', async () => {
    const db = tempDb()
    seedSmtp(db)
    const err = new Error('connect ECONNREFUSED 127.0.0.1:587')
    ;(err as NodeJS.ErrnoException).code = 'ECONNREFUSED'
    const res = await sendEmailTool(INPUT, opts(db, { transport: throwingTransport(err) }))
    expect(res).toMatchObject({ status: 'error', code: 'connection' })
  })

  it('real nodemailer adapter maps a refused connection offline', async () => {
    const db = tempDb()
    seedSmtp(db)
    // Port 1 on localhost refuses fast with no external network.
    setSetting(db, 'smtp_port', 1)
    setSetting(db, 'smtp_host', '127.0.0.1')
    const res = await sendEmailTool(INPUT, {
      db,
      keyStore: fakeKeyStore(PASSWORD),
      transport: createSmtpTransport(
        { host: '127.0.0.1', port: 1, secure: false, user: 'kieo@example.com' },
        PASSWORD
      )
    })
    expect(res).toMatchObject({ status: 'error', code: 'connection' })
    if (res.status !== 'error') return
    expect(res.message).not.toContain(PASSWORD)
  }, 30_000)
})

describe('KIEO-023 classification + approval routing', () => {
  it('draft is read_only, send is dangerous', () => {
    expect(toolRegistry.getTool('draft_email')?.classification).toBe('read_only')
    expect(toolRegistry.getTool('send_email')?.classification).toBe('dangerous')
  })

  it('draft runs with no approval; denied send never touches the transport', async () => {
    const db = tempDb()
    seedSmtp(db)
    const conv = createConversation(db, { title: 'email turn' })
    const messageId = createMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: ''
    }).id
    const transport = captureTransport()
    let approvals = 0
    const base = {
      db,
      registry: toolRegistry,
      requestApproval: async () => {
        approvals += 1
        return 'denied' as const
      },
      executeTool: async (toolName: string, input: unknown) => {
        if (toolName === 'draft_email') return draftEmailTool(input as EmailInput)
        if (toolName === 'send_email')
          return sendEmailTool(input as EmailInput, opts(db, { transport }))
        throw new Error(`unexpected ${toolName}`)
      }
    }

    const draft = await executeToolWithHITL(
      { toolCallId: 'e1', toolName: 'draft_email', input: { ...INPUT }, messageId },
      base
    )
    expect(draft).toMatchObject({ status: 'auto_approved', executed: true })
    expect(approvals).toBe(0)

    const denied = await executeToolWithHITL(
      { toolCallId: 'e2', toolName: 'send_email', input: { ...INPUT }, messageId },
      base
    )
    expect(denied).toMatchObject({ status: 'denied', executed: false })
    expect(approvals).toBe(1)
    expect(transport.calls).toHaveLength(0)
  })
})
