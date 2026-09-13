// agent-core/tools/email.ts — draft_email, send_email (KIEO-023).
//
// Transport v1 is SMTP (nodemailer), configured per call from Settings
// (host/port/secure/user, non-secret) + the key store (password, secret).
// Gmail API OAuth stays a future transport behind the same SmtpSender seam —
// OAuth needs interactive consent UX (KIEO-053) plus a Google client
// registration, while SMTP works today with app passwords and is testable
// without network. The choice is documented, not silent.
//
// Exact-match invariant (ticket AC): send_email transmits its input fields
// byte-identical — no trimming, no case folding, no paraphrase. This holds
// structurally: KIEO-013 executes the exact approved args with no LLM
// round-trip in between, and this module passes them straight to the
// transport. email.test.ts pins byte-identity (whitespace/casing preserved).
//
// Secrecy: the password is read from the key store at send time, never
// written to settings/.env/logs, and scrubbed from any error text before it
// can reach logs or the LLM.
import nodemailer from 'nodemailer'
import type { DatabaseHandle } from '../../db/database'
import { getDatabase } from '../../db/database'
import { getSetting } from '../../db/tables'
import { getKeyStore, type KeyStore } from '../../electron/secure/keyStore'
import type { ToolDispatcher } from './dispatch'

export const SETTING_SMTP_HOST = 'smtp_host'
export const SETTING_SMTP_PORT = 'smtp_port'
export const SETTING_SMTP_SECURE = 'smtp_secure'
export const SETTING_SMTP_USER = 'smtp_user'
export const KEYSTORE_SMTP_PASSWORD = 'smtp_password'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface EmailInput {
  to: string
  subject: string
  body: string
}

/** Narrow transport seam: production nodemailer adapter, fakes in tests. */
export interface SmtpSender {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<{
    messageId: string
  }>
}

export interface EmailToolOptions {
  db?: DatabaseHandle
  keyStore?: KeyStore
  /** Test seam. Production builds the nodemailer transport per send. */
  transport?: SmtpSender
}

export type EmailToolResult =
  | {
      status: 'ok'
      draft?: { to: string; subject: string; body: string }
      messageId?: string
      to?: string
      subject?: string
      message: string
    }
  | {
      status: 'error'
      code: 'config' | 'validation' | 'auth' | 'connection' | 'rejected'
      message: string
    }

function validateFields(input: EmailInput): string | null {
  if (!input || typeof input.to !== 'string' || !EMAIL_RE.test(input.to.trim())) {
    return `Invalid recipient address: ${JSON.stringify((input as EmailInput)?.to ?? null)}. Use a single email address like name@example.com.`
  }
  if (typeof input.subject !== 'string' || typeof input.body !== 'string') {
    return 'Subject and body must be strings.'
  }
  return null
}

/**
 * draft_email (read_only): prepares content, sends nothing. Returns the
 * fields verbatim so the LLM — and the KIEO-052 confirmation card, which
 * renders the request argsJson — can quote them exactly.
 */
export async function draftEmailTool(input: EmailInput): Promise<EmailToolResult> {
  const invalid = validateFields(input)
  if (invalid) return { status: 'error', code: 'validation', message: invalid }
  return {
    status: 'ok',
    draft: { to: input.to, subject: input.subject, body: input.body },
    message: `Draft ready for ${input.to} — review it carefully; nothing has been sent.`
  }
}

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
}

function readSmtpConfig(db: DatabaseHandle | null): SmtpConfig | { error: string } {
  const host = db ? getSetting<string>(db, SETTING_SMTP_HOST) : null
  const port = db ? getSetting<number>(db, SETTING_SMTP_PORT) : null
  const secure = db ? getSetting<boolean>(db, SETTING_SMTP_SECURE) : null
  const user = db ? getSetting<string>(db, SETTING_SMTP_USER) : null
  if (typeof host !== 'string' || host.trim().length === 0) {
    return { error: 'No SMTP host configured. Set it in Settings → Email first.' }
  }
  return {
    host: host.trim(),
    port: typeof port === 'number' && Number.isFinite(port) ? port : 587,
    secure: secure === true,
    user: typeof user === 'string' ? user : ''
  }
}

/** Real transport: nodemailer, built fresh per send (no pooling to go stale). */
export function createSmtpTransport(config: SmtpConfig, password: string): SmtpSender {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  })
  return {
    sendMail: async (message) => {
      const info = await transporter.sendMail({
        from: config.user || message.to,
        to: message.to,
        subject: message.subject,
        text: message.text
      })
      return { messageId: info.messageId ?? '' }
    }
  }
}

function mapSendError(err: unknown, password: string): EmailToolResult {
  const raw = err instanceof Error ? err.message : String(err)
  // Never let secret material reach logs or the LLM, even if a server or
  // library ever echoes credentials back in an error string.
  const message =
    password.length >= 4 ? raw.split(password).join('[redacted]') : raw
  const code = (err as NodeJS.ErrnoException)?.code ?? ''
  const responseCode =
    (err as { responseCode?: unknown })?.responseCode
  if (responseCode === 535 || responseCode === 534 || /authentication|credentials|password|username|5\.7\.8/i.test(message)) {
    return {
      status: 'error',
      code: 'auth',
      message: `SMTP authentication failed: ${message}. Check the SMTP username/password in Settings → Email.`
    }
  }
  if (
    typeof responseCode === 'number' ||
    /mailbox|recipient|rejected|bounce|spam|blocked|relay/i.test(message)
  ) {
    return {
      status: 'error',
      code: 'rejected',
      message: `The mail server refused the message: ${message}. The address may be invalid or the message flagged.`
    }
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|timed?\s?out|connect/i.test(message + code)) {
    return {
      status: 'error',
      code: 'connection',
      message: `Couldn't reach the SMTP server: ${message}. Check the host/port and your connection.`
    }
  }
  return { status: 'error', code: 'rejected', message }
}

/**
 * send_email (dangerous): transmits the input byte-identical via the
 * configured SMTP transport. Auth/bounce/connection failures become clear,
 * coded error results per the Error Handling Guide — never throws.
 */
export async function sendEmailTool(
  input: EmailInput,
  opts: EmailToolOptions = {}
): Promise<EmailToolResult> {
  const invalid = validateFields(input)
  if (invalid) return { status: 'error', code: 'validation', message: invalid }

  let db: DatabaseHandle | null = null
  try {
    db = opts.db ?? getDatabase()
  } catch {
    db = null
  }
  const config = readSmtpConfig(db)
  if ('error' in config) return { status: 'error', code: 'config', message: config.error }

  let keyStore: KeyStore | null = null
  try {
    keyStore = opts.keyStore ?? getKeyStore()
  } catch {
    keyStore = null
  }
  const password = keyStore?.getKey(KEYSTORE_SMTP_PASSWORD) ?? null
  if (!password) {
    return {
      status: 'error',
      code: 'config',
      message:
        'No SMTP password stored. Add it in Settings → Email (it is kept in the OS keychain, never in plaintext).'
    }
  }

  const sender = opts.transport ?? createSmtpTransport(config, password)
  try {
    // Byte-identical transmission: no trim, no case fold, no rewrite.
    const { messageId } = await sender.sendMail({
      from: config.user || input.to,
      to: input.to,
      subject: input.subject,
      text: input.body
    })
    return {
      status: 'ok',
      messageId,
      to: input.to,
      subject: input.subject,
      message: `Sent to ${input.to}${messageId ? ` (id ${messageId})` : ''}.`
    }
  } catch (err) {
    return mapSendError(err, password)
  }
}

export function registerEmailTools(
  dispatcher: ToolDispatcher,
  opts: EmailToolOptions = {}
): void {
  dispatcher.register('draft_email', (input) =>
    draftEmailTool(input as EmailInput)
  )
  dispatcher.register('send_email', (input) =>
    sendEmailTool(input as EmailInput, opts)
  )
}
