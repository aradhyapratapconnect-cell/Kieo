// src/views/Memory.tsx — editable durable-fact list (KIEO-041).
//
// Reads via the whitelisted IPC bridge (window.kieo); edits route through
// memory-update (stamps edited_by_user=1) and deletes through memory-delete.
// Deleted rows are gone from the DB, so the next agent turn's system context
// (buildMemoryContext) can never see them again (ticket AC3).
import { useCallback, useEffect, useState } from 'react'
import type { MemoryFactDto } from '../../shared/types'

export default function MemoryView(): JSX.Element {
  const [facts, setFacts] = useState<MemoryFactDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) {
      setError('Memory unavailable outside the desktop app.')
      setFacts([])
      return
    }
    let cancelled = false
    setError(null)
    api
      .listMemoryFacts()
      .then((rows) => {
        if (!cancelled) setFacts(rows)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setFacts([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cleanup = load()
    return cleanup
  }, [load])

  function startEdit(fact: MemoryFactDto): void {
    setEditingId(fact.id)
    setDraft(fact.fact)
    setError(null)
  }

  async function saveEdit(id: string): Promise<void> {
    const value = draft.replace(/\s+/g, ' ').trim()
    if (!value) {
      setError('Fact cannot be empty.')
      return
    }
    setBusyId(id)
    setError(null)
    try {
      const res = await window.kieo.updateMemoryFact(id, value)
      if (!res.ok) {
        setError('Could not save that edit — try again.')
        return
      }
      setFacts((prev) =>
        (prev ?? []).map((f) =>
          f.id === id ? { ...f, fact: value, edited_by_user: 1 } : f
        )
      )
      setEditingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(id: string): Promise<void> {
    setBusyId(id)
    setError(null)
    try {
      const res = await window.kieo.deleteMemoryFact(id)
      if (!res.ok) {
        setError('Could not delete that fact — try again.')
        return
      }
      setFacts((prev) => (prev ?? []).filter((f) => f.id !== id))
      if (editingId === id) setEditingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  if (facts === null) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-10 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Loading memory…
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-6 text-left">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[20px] font-semibold leading-[28px]">Memory</h2>
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          {facts.length} {facts.length === 1 ? 'fact' : 'facts'}
        </span>
      </div>
      <p className="text-[13px] text-text-secondary">
        Durable things Kieo learned about you. Edits apply to the next reply; deleted
        facts are forgotten immediately.
      </p>
      {error !== null && (
        <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          {error}
        </p>
      )}
      {facts.length === 0 ? (
        <div className="rounded border border-white/[0.07] bg-surface/65 px-4 py-6 text-center backdrop-blur-[16px]">
          <p className="text-[15px] text-text-secondary">No memory facts yet.</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Tell Kieo something durable, e.g. “I use pnpm, not npm”.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {facts.map((fact) => {
            const isEditing = editingId === fact.id
            const busy = busyId === fact.id
            return (
              <li
                key={fact.id}
                className="rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]"
              >
                {isEditing ? (
                  <div className="flex flex-col gap-2">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveEdit(fact.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      disabled={busy}
                      aria-label="Edit memory fact"
                      className="w-full rounded border border-white/[0.12] bg-bg-base px-2 py-1 text-[15px] text-text-primary focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEdit(fact.id)}
                        disabled={busy || draft.trim().length === 0}
                        className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                        className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-primary disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-[15px] text-text-primary">{fact.fact}</p>
                      {fact.edited_by_user === 1 && (
                        <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
                          edited by you
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(fact)}
                        disabled={busy}
                        aria-label={`Edit ${fact.fact}`}
                        className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-0.5 text-[13px] text-text-secondary hover:text-text-primary disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(fact.id)}
                        disabled={busy}
                        aria-label={`Delete ${fact.fact}`}
                        className="rounded border border-danger/60 bg-danger/10 px-2 py-0.5 text-[13px] text-danger disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
