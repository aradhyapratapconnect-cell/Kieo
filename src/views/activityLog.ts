// src/views/activityLog.ts — pure Activity/Dashboard helpers (KIEO-042).
//
// DOM/Electron-free so vitest covers them headlessly: safe JSON parsing
// (every tool_execution_log row must render without any other data source,
// even with corrupt args/result payloads), display truncation, timestamp
// formatting, and Dashboard aggregation.
import type { ToolExecutionLogDto } from '../../shared/types'

export const PREVIEW_CHARS = 500

/** Parse a JSON column; null on empty/malformed (never throws). */
export function safeParseJson(raw: string | null): unknown {
  if (raw === null || raw.trim().length === 0) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** Pretty-print for <pre> blocks; falls back to String() for odd values. */
export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Truncate long previews; returns the display text + whether it was cut. */
export function truncatePreview(text: string, max = PREVIEW_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** Local date-time for a created_at ms timestamp; never throws. */
export function formatLogTime(createdAt: number): string {
  try {
    const d = new Date(createdAt)
    if (Number.isNaN(d.getTime())) return String(createdAt)
    return d.toLocaleString()
  } catch {
    return String(createdAt)
  }
}

export interface ToolLogSummary {
  total: number
  readOnly: number
  dangerous: number
  approved: number
  denied: number
  timeout: number
  autoApproved: number
}

/** Aggregate counts for the Dashboard stat cards. */
export function summarizeToolLogs(logs: ToolExecutionLogDto[]): ToolLogSummary {
  const summary: ToolLogSummary = {
    total: logs.length,
    readOnly: 0,
    dangerous: 0,
    approved: 0,
    denied: 0,
    timeout: 0,
    autoApproved: 0
  }
  for (const log of logs) {
    if (log.classification === 'read_only') summary.readOnly += 1
    else if (log.classification === 'dangerous') summary.dangerous += 1
    switch (log.approval_status) {
      case 'approved':
        summary.approved += 1
        break
      case 'denied':
        summary.denied += 1
        break
      case 'timeout':
        summary.timeout += 1
        break
      case 'auto_approved':
        summary.autoApproved += 1
        break
    }
  }
  return summary
}
