// src/components/attachments.test.ts — KIEO-063 attach coverage (pnpm test).
import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS,
  formatCommandWithAttachments,
  fromValidation,
  mergeAttachments,
  validAttachmentPaths,
  type AttachedFile
} from './attachments'

function file(display: string, resolved: string | null, ok = true): AttachedFile {
  return { display, resolved, ok }
}

describe('KIEO-063 attachments', () => {
  it('formats only validated paths into the command block', () => {
    expect(formatCommandWithAttachments('summarize this', [])).toBe('summarize this')
    expect(
      formatCommandWithAttachments('summarize this', [file('evil', null, false)])
    ).toBe('summarize this')
    expect(
      formatCommandWithAttachments('summarize this', [
        file('/ws/a.txt', '/ws/a.txt'),
        file('/outside', null, false),
        file('/ws/b.txt', '/ws/b.txt')
      ])
    ).toBe('summarize this\n\n[Attached files]\n- /ws/a.txt\n- /ws/b.txt')
  })

  it('maps validation DTOs, preferring resolved paths for display', () => {
    expect(
      fromValidation([
        { input: '/ws/a.txt', ok: true, resolved: '/ws/a.txt' },
        { input: '../../etc/passwd', ok: false, resolved: null }
      ])
    ).toEqual([
      { display: '/ws/a.txt', resolved: '/ws/a.txt', ok: true },
      { display: '../../etc/passwd', resolved: null, ok: false }
    ])
  })

  it('merges drops deduped and capped', () => {
    const merged = mergeAttachments(
      [file('/ws/a.txt', '/ws/a.txt')],
      [file('/ws/a.txt', '/ws/a.txt'), file('/ws/b.txt', '/ws/b.txt')]
    )
    expect(merged.map((f) => f.display)).toEqual(['/ws/a.txt', '/ws/b.txt'])
    const many = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) =>
      file(`/ws/${i}.txt`, `/ws/${i}.txt`)
    )
    expect(mergeAttachments([], many)).toHaveLength(MAX_ATTACHMENTS)
  })

  it('extracts only usable paths', () => {
    expect(
      validAttachmentPaths([file('a', '/ws/a', true), file('b', null, false)])
    ).toEqual(['/ws/a'])
  })
})
