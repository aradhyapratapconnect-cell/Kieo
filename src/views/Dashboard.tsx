// src/views/Dashboard.tsx — action summary + recent tools (KIEO-042).
//
// Same tool_execution_log source as Activity, aggregated client-side into
// stat cards. Subscribes to the same 'tool-logs-updated' push so counts and
// recents stay live during the session.
import { useCallback, useEffect, useState } from 'react'
import type { ToolExecutionLogDto } from '../../shared/types'
import { formatLogTime, summarizeToolLogs } from './activityLog'

function StatCard({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]">
      <p className="font-display text-[20px] font-semibold leading-[28px]">{value}</p>
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
        {label}
      </p>
    </div>
  )
}

export default function DashboardView(): JSX.Element {
  const [logs, setLogs] = useState<ToolExecutionLogDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const fetchLogs = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) {
      setError('Dashboard unavailable outside the desktop app.')
      setLogs([])
      return
    }
    setError(null)
    api
      .listToolLogs({ limit: 200 })
      .then((rows) => setLogs(rows))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setLogs([])
      })
  }, [refreshTick])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) return
    const unsubscribe = api.onToolLogsUpdated(() => {
      setRefreshTick((t) => t + 1)
    })
    return unsubscribe
  }, [])

  const summary = logs === null ? null : summarizeToolLogs(logs)
  const recent = logs === null ? [] : logs.slice(0, 10)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[20px] font-semibold leading-[28px]">Dashboard</h2>
        <button
          type="button"
          onClick={() => setRefreshTick((t) => t + 1)}
          className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary hover:text-text-primary"
        >
          Refresh
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          {error}
        </p>
      )}

      {summary === null ? (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Loading dashboard…
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label="Total actions" value={summary.total} />
            <StatCard label="Dangerous" value={summary.dangerous} />
            <StatCard label="Read-only" value={summary.readOnly} />
            <StatCard label="Denied" value={summary.denied} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Approved" value={summary.approved} />
            <StatCard label="Auto-approved" value={summary.autoApproved} />
            <StatCard label="Timed out" value={summary.timeout} />
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="font-display text-[16px] font-semibold leading-[24px]">Recent</h3>
            {recent.length === 0 ? (
              <div className="rounded border border-white/[0.07] bg-surface/65 px-4 py-6 text-center backdrop-blur-[16px]">
                <p className="text-[15px] text-text-secondary">No actions yet.</p>
                <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
                  Run a command to see it here.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {recent.map((log) => (
                  <li
                    key={log.id}
                    className="flex items-center justify-between gap-3 rounded border border-white/[0.07] bg-surface/65 px-3 py-1.5 backdrop-blur-[16px]"
                  >
                    <p className="break-all font-mono text-[13px] text-text-primary">
                      {log.tool_name}
                      <span className="ml-2 text-[11px] uppercase tracking-[0.06em] text-text-muted">
                        {log.classification} · {log.approval_status}
                      </span>
                    </p>
                    <p className="shrink-0 font-mono text-[11px] text-text-muted">
                      {formatLogTime(log.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
