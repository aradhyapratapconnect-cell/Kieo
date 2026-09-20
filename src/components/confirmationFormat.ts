// src/components/confirmationFormat.ts — HITL card content (KIEO-052).
//
// Pure, headless mapping from a tool call to what the Confirmation Card
// shows. Every field value is the EXACT approved argument — never trimmed,
// case-folded, or paraphrased — so what the user reads is byte-identical to
// what executeToolWithHITL() will run (ticket AC1).
import type { HitlRequest } from '../../shared/types'

export type CardSeverity = 'caution' | 'destructive'

export interface CardField {
  label: string
  value: string
}

export interface ToolCardContent {
  /** Human title, e.g. "Run shell command". */
  title: string
  /** Top-stripe color: amber (caution) or crimson (destructive). */
  severity: CardSeverity
  /** Verbatim fields in display order. */
  fields: CardField[]
}

/** Destructive = irreversible or externally visible (delete, send). */
function severityFor(toolName: string): CardSeverity {
  if (toolName === 'delete_file' || toolName === 'send_email') return 'destructive'
  return 'caution'
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function strArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((v) => typeof v === 'string')) return null
  return value as string[]
}

/**
 * Describe one tool call for the card. Malformed argsJson never throws —
 * the raw payload is shown instead so nothing the agent asked for is hidden.
 */
export function describeToolCall(toolName: string, argsJson: string): ToolCardContent {
  const severity = severityFor(toolName)
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('non-object args')
    }
    args = parsed as Record<string, unknown>
  } catch {
    return {
      title: toolName,
      severity,
      fields: [{ label: 'Raw arguments', value: argsJson }]
    }
  }

  switch (toolName) {
    case 'execute_shell': {
      const fields: CardField[] = [
        { label: 'Command', value: str(args['command']) ?? '—' },
        {
          label: 'Arguments',
          value: (() => {
            const list = strArray(args['args'])
            if (!list) return '—'
            return list.length > 0 ? list.join('\n') : '—'
          })()
        },
        { label: 'Working directory', value: str(args['cwd']) ?? '.' }
      ]
      return { title: 'Run shell command', severity, fields }
    }
    case 'delete_file':
      return {
        title: 'Delete file',
        severity,
        fields: [{ label: 'File path', value: str(args['path']) ?? '—' }]
      }
    case 'write_file':
      return {
        title: 'Write file',
        severity,
        fields: [
          { label: 'File path', value: str(args['path']) ?? '—' },
          { label: 'New content', value: str(args['content']) ?? '—' }
        ]
      }
    case 'read_file':
      return {
        title: 'Read file',
        severity,
        fields: [{ label: 'File path', value: str(args['path']) ?? '—' }]
      }
    case 'send_email':
      return {
        title: 'Send email',
        severity,
        fields: [
          { label: 'To', value: str(args['to']) ?? '—' },
          { label: 'Subject', value: str(args['subject']) ?? '—' },
          { label: 'Body', value: str(args['body']) ?? '—' }
        ]
      }
    case 'draft_email':
      return {
        title: 'Draft email',
        severity,
        fields: [
          { label: 'To', value: str(args['to']) ?? '—' },
          { label: 'Subject', value: str(args['subject']) ?? '—' },
          { label: 'Body', value: str(args['body']) ?? '—' }
        ]
      }
    case 'github_commit':
      return {
        title: 'Create git commit',
        severity,
        fields: [
          { label: 'Repository', value: str(args['repoPath']) ?? '—' },
          { label: 'Commit message', value: str(args['message']) ?? '—' }
        ]
      }
    case 'github_open_pr':
      return {
        title: 'Open pull request',
        severity,
        fields: [
          { label: 'Repository', value: str(args['repoPath']) ?? '—' },
          { label: 'Title', value: str(args['title']) ?? '—' },
          { label: 'Body', value: str(args['body']) ?? '—' },
          { label: 'Base', value: str(args['base']) ?? 'main' },
          { label: 'Head', value: str(args['head']) ?? '—' }
        ]
      }
    case 'github_status':
      return {
        title: 'Check repository status',
        severity,
        fields: [{ label: 'Repository', value: str(args['repoPath']) ?? '—' }]
      }
    case 'open_app':
      return {
        title: 'Open application',
        severity,
        fields: [{ label: 'Application', value: str(args['appName']) ?? '—' }]
      }
    default:
      return {
        title: toolName,
        severity,
        fields: [{ label: 'Arguments', value: JSON.stringify(args, null, 2) }]
      }
  }
}

/** Convenience wrapper for a full HitlRequest payload. */
export function describeHitlRequest(req: HitlRequest): ToolCardContent {
  return describeToolCall(req.toolName, req.argsJson)
}
