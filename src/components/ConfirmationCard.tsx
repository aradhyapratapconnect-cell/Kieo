// src/components/ConfirmationCard.tsx — HITL approval UI (KIEO-052).
//
// Level 3 / Safety Intercept surface per the Frontend Specification: opaque
// layered glass, danger outline + warning glow, 3px severity stripe, verbatim
// JetBrains Mono action fields, Approve/Deny buttons with hotkey chips, and
// a voice-confirmation note. Button clicks emit the `hitl-response` IPC event
// consumed by KIEO-013's pending-approval map (same path as voice "yes"/"no"
// from the KIEO-033 approval channel).
//
// Safety notes:
//   * Values render EXACTLY as received (describeToolCall never normalizes),
//     so the card is byte-identical to what would execute.
//   * Hotkeys ignore keystrokes typed in inputs/textareas: while a card is
//     pending, command-bar text must queue as a command (KIEO-033), never
//     accidentally approve. Escape inside an input just blurs it.
//   * The overlay clears when the agent leaves AWAITING_APPROVAL without a
//     click (voice decision or 60s timeout) so a stale card can never linger.
import { useEffect, useRef, useState } from 'react'
import type { HitlRequest } from '../../shared/types'
import { describeHitlRequest } from './confirmationFormat'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export function ConfirmationCard({
  request,
  onApprove,
  onDeny
}: {
  request: HitlRequest
  onApprove: (toolCallId: string) => void
  onDeny: (toolCallId: string) => void
}): JSX.Element {
  const content = describeHitlRequest(request)
  const destructive = content.severity === 'destructive'
  const approveRef = useRef<HTMLButtonElement | null>(null)

  // Focus Approve on open so Enter works immediately; hotkeys stay dormant
  // while the user types in any input (see module notes).
  useEffect(() => {
    approveRef.current?.focus()
  }, [request.toolCallId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }
      if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') {
        e.preventDefault()
        onApprove(request.toolCallId)
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault()
        onDeny(request.toolCallId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request.toolCallId, onApprove, onDeny])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hitl-card-title"
        aria-describedby="hitl-card-fields"
        className="w-full max-w-xl overflow-hidden rounded-lg border bg-surface/95 shadow-[0_0_24px_-2px_rgba(239,68,68,0.25)] backdrop-blur-[24px]"
        style={{ borderColor: 'rgba(239,68,68,0.4)' }}
      >
        {/* Severity stripe: amber caution, crimson destructive (spec 1.4). */}
        <div className={`h-[3px] w-full ${destructive ? 'bg-danger' : 'bg-caution'}`} />
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2
              id="hitl-card-title"
              className="font-display text-[16px] font-semibold leading-[24px]"
            >
              {content.title} — approval required
            </h2>
            <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
              {request.classification}
            </span>
          </div>

          <div id="hitl-card-fields" className="flex flex-col gap-2">
            {content.fields.map((field) => (
              <div key={field.label} className="flex flex-col gap-1">
                <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary">
                  {field.label}
                </p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-white/[0.12] bg-bg-base px-3 py-2 font-mono text-[13px] text-text-primary">
                  {field.value}
                </pre>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              ref={approveRef}
              type="button"
              onClick={() => onApprove(request.toolCallId)}
              className="rounded bg-safe px-4 py-1.5 text-[14px] font-semibold text-bg-base"
            >
              Approve{' '}
              <span className="ml-1 rounded bg-black/25 px-1 font-mono text-[11px]">[Y]/[↵]</span>
            </button>
            <button
              type="button"
              onClick={() => onDeny(request.toolCallId)}
              className="rounded border border-danger bg-danger/10 px-4 py-1.5 text-[14px] font-semibold text-danger"
            >
              Deny <span className="ml-1 rounded px-1 font-mono text-[11px]">[N]/[Esc]</span>
            </button>
          </div>

          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Voice confirmation also accepted (“yes” / “no”) · No response times out
            safely — nothing runs
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Live bridge: subscribes to `hitl-request`, shows the head of the queue as
 * a full-view overlay (approvals are strictly serial — the loop guarantees
 * it), and emits `hitl-response` on click. Drops the head whenever the agent
 * leaves AWAITING_APPROVAL without a click, covering voice resolutions and
 * the 60s timeout alike.
 */
export function ConfirmationOverlay(): JSX.Element | null {
  const [queue, setQueue] = useState<HitlRequest[]>([])

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) return
    const unsubscribeRequest = api.onHitlRequest((req) => {
      setQueue((q) =>
        q.some((r) => r.toolCallId === req.toolCallId) ? q : [...q, req]
      )
    })
    const unsubscribeState = api.onAgentState((state) => {
      if (state !== 'AWAITING_APPROVAL') {
        setQueue((q) => (q.length > 0 ? q.slice(1) : q))
      }
    })
    return () => {
      unsubscribeRequest()
      unsubscribeState()
    }
  }, [])

  const head = queue[0]
  if (!head) return null

  const answer = (status: 'approved' | 'denied'): void => {
    window.kieo.sendHitlResponse({ toolCallId: head.toolCallId, status })
    setQueue((q) => q.filter((r) => r.toolCallId !== head.toolCallId))
  }

  return (
    <ConfirmationCard
      request={head}
      onApprove={() => answer('approved')}
      onDeny={() => answer('denied')}
    />
  )
}

export default ConfirmationCard
