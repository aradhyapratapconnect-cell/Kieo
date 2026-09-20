// src/components/confirmationFormat.test.ts — KIEO-052 card-content coverage.
import { describe, expect, it } from 'vitest'
import { describeHitlRequest, describeToolCall } from './confirmationFormat'
import type { HitlRequest } from '../../shared/types'

function req(toolName: string, args: unknown): HitlRequest {
  return {
    toolCallId: 'c1',
    toolName,
    argsJson: typeof args === 'string' ? args : JSON.stringify(args),
    classification: 'dangerous',
    permissionActionType: toolName
  }
}

describe('KIEO-052 confirmation card content (verbatim, 3+ tool types)', () => {
  it('renders shell commands verbatim (command, args, cwd)', () => {
    const content = describeToolCall(
      'execute_shell',
      JSON.stringify({ command: 'npm', args: ['run', 'build --watch'], cwd: 'packages/app' })
    )
    expect(content.title).toBe('Run shell command')
    expect(content.severity).toBe('caution')
    expect(content.fields).toEqual([
      { label: 'Command', value: 'npm' },
      { label: 'Arguments', value: 'run\nbuild --watch' },
      { label: 'Working directory', value: 'packages/app' }
    ])
  })

  it('renders file deletes verbatim and marks them destructive', () => {
    const content = describeToolCall('delete_file', JSON.stringify({ path: '  Notes/TODO.md  ' }))
    expect(content.title).toBe('Delete file')
    expect(content.severity).toBe('destructive')
    // No trimming: what the user reads is what would run.
    expect(content.fields).toEqual([{ label: 'File path', value: '  Notes/TODO.md  ' }])
  })

  it('renders email fields exactly (case + whitespace preserved)', () => {
    const body = 'Hi Ada,\n\n  Please REVIEW this.  \nThanks!'
    const content = describeToolCall(
      'send_email',
      JSON.stringify({ to: 'Ada@Example.com', subject: '  Q3 Report ', body })
    )
    expect(content.title).toBe('Send email')
    expect(content.severity).toBe('destructive')
    expect(content.fields).toEqual([
      { label: 'To', value: 'Ada@Example.com' },
      { label: 'Subject', value: '  Q3 Report ' },
      { label: 'Body', value: body }
    ])
  })

  it('covers write_file, github, and open_app tools', () => {
    expect(
      describeToolCall('write_file', JSON.stringify({ path: 'a.txt', content: 'hi' })).fields
    ).toEqual([
      { label: 'File path', value: 'a.txt' },
      { label: 'New content', value: 'hi' }
    ])
    expect(
      describeToolCall(
        'github_commit',
        JSON.stringify({ repoPath: '/repo', message: 'feat: add x' })
      ).fields[1]
    ).toEqual({ label: 'Commit message', value: 'feat: add x' })
    expect(
      describeToolCall('open_app', JSON.stringify({ appName: 'Calculator' })).fields
    ).toEqual([{ label: 'Application', value: 'Calculator' }])
  })

  it('never hides the payload: unknown tools and malformed JSON fall back', () => {
    const unknown = describeToolCall('future_tool', JSON.stringify({ a: 1 }))
    expect(unknown.title).toBe('future_tool')
    expect(unknown.fields).toHaveLength(1)

    const malformed = describeToolCall('delete_file', '{not json')
    expect(malformed.fields).toEqual([{ label: 'Raw arguments', value: '{not json' }])
  })

  it('describeHitlRequest unwraps full IPC payloads', () => {
    const content = describeHitlRequest(req('delete_file', { path: 'b.txt' }))
    expect(content.fields).toEqual([{ label: 'File path', value: 'b.txt' }])
  })
})
