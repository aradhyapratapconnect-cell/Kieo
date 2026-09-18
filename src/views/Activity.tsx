// src/views/Activity.tsx — chronological tool history (KIEO-042).
//
// Reads tool_execution_log via IPC (the single source of truth — every field
// renders from the row alone), filters server-side by classification and
// approval status, and refetches live on 'tool-logs-updated' pushes from the
// main process after every executed tool.
import { useCallback, useEffect, useState } from 'react'
import type {
  ApprovalStatus,
  ToolClassification,
  ToolExecutionLogDto
} from '../../shared/types'
import { formatLogTime, prettyJson, safeParseJson } from './activityLog'

type ClassificationFilter = 'all' | ToolClassification
type ApprovalFilter = 'all' | ApprovalStatus

const CLASSIFICATION_OPTIONS: Array<{ value: ClassificationFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'read_only', label: 'Read-only' },
  { value: 'dangerous', label: 'Dangerous' }
]

const APPROVAL_OPTIONS: Array<{ value: ApprovalFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'auto_approved', label: 'Auto' },
  { value: 'denied', label: 'Denied' },
  { value: 'timeout', label: 'Timeout' }
]

function classificationBadge(classification: ToolClassification): string {
  return classification === 'read_only' ? 'text-safe' : 'text-caution'
}

function approvalBadge(status: ApprovalStatus): string {
  if (status === 'approved' || status === 'auto_approved') return 'text-safe'
  if (status === 'denied') return 'text-danger'
  return 'text-caution'
}

function FilterButton({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] ${
        active
          ? 'border-primary/60 text-primary-bright'
          : 'border-white/10 text-text-muted hover:text-text-secondary'
      }`}
    >
      {label}
    </button>
  )
}

export default function ActivityView(): JSX.Element {
  const [logs, setLogs] = useState<ToolExecutionLogDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [classification, setClassification] = useState<ClassificationFilter>('all')
  const [approval, setApproval] = useState<ApprovalFilter>('all')
  const [refreshTick, setRefreshTick] = useState(0)

  const fetchLogs = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) {
      setError('Activity unavailable outside the desktop app.')
      setLogs([])
      return
    }
    setError(null)
    api
      .listToolLogs({
        ...(classification !== 'all' ? { classification } : {}),
        ...(approval !== 'all' ? { approvalStatus: approval } : {}),
        limit: 200
      })
      .then((rows) => setLogs(rows))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setLogs([])
      })
  }, [classification, approval, refreshTick])

  // Initial + filter-driven fetch.
  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Live updates: main pushes after every executed tool (KIEO-042 AC3).
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) return
    const unsubscribe = api.onToolLogsUpdated(() => {
      setRefreshTick((t) => t + 1)
    })
    return unsubscribe
  }, [])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-6 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[20px] font-semibold leading-[28px]">Activity</h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            {logs === null ? '…' : `${logs.length} ${logs.length === 1 ? 'action' : 'actions'}`}
          </span>
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary"
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="text-[13px] text-text-secondary">
        Every action Kieo has taken, newest first. Updates live as tools run.
      </p>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Type
          </span>
          {CLASSIFICATION_OPTIONS.map((opt) => (
            <FilterButton
              key={opt.value}
              label={opt.label}
              active={classification === opt.value}
              onClick={() => setClassification(opt.value)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Approval
          </span>
          {APPROVAL_OPTIONS.map((opt) => (
            <FilterButton
              key={opt.value}
              label={opt.label}
              active={approval === opt.value}
              onClick={() => setApproval(opt.value)}
            />
          ))}
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          {error}
        </p>
      )}

      {logs === null ? (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Loading activity…
        </p>
      ) : logs.length === 0 ? (
        <div className="rounded border border-white/[0.07] bg-surface/65 px-4 py-6 text-center backdrop-blur-[16px]">
          <p className="text-[15px] text-text-secondary">No actions match these filters.</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Run a command, or clear the filters.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {logs.map((log) => {
            const args = safeParseJson(log.args_json)
            const result = safeParseJson(log.result_json)
            return (
              <li
                key={log.id}
                className="rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="break-all font-mono text-[13px] text-text-primary">
                    {log.tool_name}
                  </p>
                  <p className="shrink-0 font-mono text-[11px] text-text-muted">
                    {formatLogTime(log.created_at)}
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] uppercase tracking-[0.06em]">
                  <span className={classificationBadge(log.classification)}>
                    {log.classification}
                  </span>
                  <span className={approvalBadge(log.approval_status)}>
                    {log.approval_status}
                  </span>
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  <details>
                    <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary">
                      Arguments
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-base px-2 py-1 font-mono text-[12px] text-text-secondary">
                      {prettyJson(args)}
                    </pre>
                  </details>
                  <details>
                    <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary">
                      Result
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-base px-2 py-1 font-mono text-[12px] text-text-secondary">
                      {log.result_json === null ? '—' : prettyJson(result)}
                    </pre>
                  </details>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
