// src/views/activityLog.test.ts — KIEO-042 helper coverage (pnpm test).
//
// Headless: pure formatting/aggregation plus the shared filter normalizer
// the main-process IPC bridge relies on. No DOM, no Electron.
import { describe, expect, it } from 'vitest'
import { normalizeToolLogsFilter, type ToolExecutionLogDto } from '../../shared/types'
import {
  formatLogTime,
  prettyJson,
  safeParseJson,
  summarizeToolLogs,
  truncatePreview
} from './activityLog'

function log(
  overrides: Partial<ToolExecutionLogDto> = {},
  id = Math.random().toString(36).slice(2)
): ToolExecutionLogDto {
  return {
    id,
    message_id: 'msg-1',
    tool_name: 'read_file',
    args_json: JSON.stringify({ path: 'a.txt' }),
    classification: 'read_only',
    approval_status: 'auto_approved',
    result_json: JSON.stringify({ ok: true }),
    created_at: 1_700_000_000_000,
    ...overrides
  }
}

describe('KIEO-042 log formatting (every row renders standalone)', () => {
  it('parses JSON columns safely, never throwing', () => {
    expect(safeParseJson(JSON.stringify({ path: 'a' }))).toEqual({ path: 'a' })
    expect(safeParseJson(null)).toBeNull()
    expect(safeParseJson('')).toBeNull()
    expect(safeParseJson('not-json{{{')).toBeNull()
  })

  it('pretty-prints values and truncates long previews', () => {
    expect(prettyJson({ a: 1 })).toContain('"a"')
    expect(prettyJson('plain')).toBe('plain')
    expect(prettyJson(null)).toBe('—')
    expect(truncatePreview('abc', 5)).toEqual({ text: 'abc', truncated: false })
    const cut = truncatePreview('x'.repeat(600))
    expect(cut.truncated).toBe(true)
    expect(cut.text).toHaveLength(500)
  })

  it('formats timestamps without throwing', () => {
    expect(formatLogTime(1_700_000_000_000).length).toBeGreaterThan(0)
    expect(formatLogTime(Number.NaN)).toBe(String(Number.NaN))
  })

  it('summarizes counts for the Dashboard cards', () => {
    const logs = [
      log({ classification: 'read_only', approval_status: 'auto_approved' }, '1'),
      log({ classification: 'dangerous', approval_status: 'approved' }, '2'),
      log({ classification: 'dangerous', approval_status: 'denied' }, '3'),
      log({ classification: 'dangerous', approval_status: 'timeout' }, '4')
    ]
    expect(summarizeToolLogs(logs)).toEqual({
      total: 4,
      readOnly: 1,
      dangerous: 3,
      approved: 1,
      denied: 1,
      timeout: 1,
      autoApproved: 1
    })
    expect(summarizeToolLogs([]).total).toBe(0)
  })
})

describe('KIEO-042 filter normalization (shared main/renderer contract)', () => {
  it('passes valid filters through and clamps limits', () => {
    expect(
      normalizeToolLogsFilter({ classification: 'dangerous', approvalStatus: 'denied', limit: 50 })
    ).toEqual({ classification: 'dangerous', approvalStatus: 'denied', limit: 50 })
    expect(normalizeToolLogsFilter({})).toEqual({
      classification: undefined,
      approvalStatus: undefined,
      limit: 200
    })
    expect(normalizeToolLogsFilter({ limit: 9999 }).limit).toBe(500)
    expect(normalizeToolLogsFilter({ limit: 0 }).limit).toBe(1)
  })

  it('drops invalid enum values instead of breaking SQL', () => {
    expect(
      normalizeToolLogsFilter({
        // @ts-expect-error intentional invalid payload from the renderer
        classification: 'evil',
        // @ts-expect-error intentional invalid payload from the renderer
        approvalStatus: 'maybe',
        limit: Number.NaN
      })
    ).toEqual({ classification: undefined, approvalStatus: undefined, limit: 200 })
    expect(normalizeToolLogsFilter(null)).toEqual({
      classification: undefined,
      approvalStatus: undefined,
      limit: 200
    })
  })
})
