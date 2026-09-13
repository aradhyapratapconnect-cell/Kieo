// electron/ipc/hitl.ts — HITL approval request/response IPC channel (KIEO-013).
//
// Main-process transport for executeToolWithHITL (agent-core/hitl.ts holds the
// policy/logging logic and stays Electron-free for unit tests).
//
// Protocol:
//   main -> renderer  'hitl-request'  HitlRequest (exact tool call, verbatim)
//   renderer -> main  'hitl-response' HitlResponse { toolCallId, approved|denied }
//
// Exactly one terminal decision per toolCallId: the first response wins, late
// or unknown responses are ignored with a warning, and a hard timeout
// (HITL_TIMEOUT_MS env, default 60000, floor 1000ms) resolves 'timeout' when
// the renderer stays silent — e.g. before the ConfirmationCard (KIEO-052)
// exists. Nothing ever auto-approves: the only path to execution is an
// explicit 'approved' resolution.
//
// KIEO-033 (voice confirmation) reuses resolvePendingApproval: a recognized
// spoken approve/deny phrase resolves the same pending entry as a card click.
import { ipcMain } from 'electron'
import type { HitlRequest, HitlResponse } from '../../shared/types'
import type { HitlDecision, RequestApproval } from '../../agent-core/hitl'
import { getAgentWindow } from './agentState'

export const DEFAULT_HITL_TIMEOUT_MS = 60_000
const MIN_HITL_TIMEOUT_MS = 1_000

/** Tunable without restart; tests inject short values through the env. */
export function readHitlTimeoutMs(): number {
  const raw = Number(process.env['HITL_TIMEOUT_MS'])
  if (!Number.isFinite(raw) || raw < MIN_HITL_TIMEOUT_MS) return DEFAULT_HITL_TIMEOUT_MS
  return Math.floor(raw)
}

interface PendingApproval {
  toolName: string
  resolve: (decision: HitlDecision) => void
  timer: NodeJS.Timeout
}

const pendingApprovals = new Map<string, PendingApproval>()

/** Number of approvals currently awaiting a decision (diagnostics/tests). */
export function pendingApprovalCount(): number {
  return pendingApprovals.size
}

/**
 * Resolve a pending approval from any trusted main-process source (approval
 * card click today, voice phrase in KIEO-033). Returns false when the id is
 * unknown or already settled (late responses are ignored, never applied).
 */
export function resolvePendingApproval(
  toolCallId: string,
  decision: 'approved' | 'denied'
): boolean {
  const pending = pendingApprovals.get(toolCallId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingApprovals.delete(toolCallId)
  pending.resolve(decision)
  return true
}

function settle(toolCallId: string, decision: HitlDecision): void {
  const pending = pendingApprovals.get(toolCallId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingApprovals.delete(toolCallId)
  pending.resolve(decision)
}

/**
 * Production RequestApproval: sends the exact tool call to the renderer and
 * awaits one 'hitl-response' or the hard timeout — whichever settles first.
 */
export const requestApprovalViaRenderer: RequestApproval = (req) => {
  const timeoutMs = readHitlTimeoutMs()
  return new Promise<HitlDecision>((resolve) => {
    if (pendingApprovals.has(req.toolCallId)) {
      settle(req.toolCallId, 'timeout')
    }
    const win = getAgentWindow()
    if (!win || win.isDestroyed()) {
      console.error(
        '[kieo] HITL approval requested with no live window — treating as timeout (nothing executes).'
      )
      resolve('timeout')
      return
    }
    const timer = setTimeout(() => {
      console.warn(
        `[kieo] HITL approval timed out after ${timeoutMs}ms for "${req.toolName}" — aborted, nothing executed.`
      )
      settle(req.toolCallId, 'timeout')
    }, timeoutMs)
    pendingApprovals.set(req.toolCallId, {
      toolName: req.toolName,
      resolve,
      timer
    })
    const payload: HitlRequest = {
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      argsJson: JSON.stringify(req.input),
      classification: req.classification,
      permissionActionType: req.permissionActionType
    }
    // toolCallId + tool name only: arguments may carry secrets (email bodies,
    // file contents) and must never land in logs.
    console.log(
      `[kieo] HITL approval pending: "${req.toolName}" (id ${req.toolCallId}, ${req.classification}) — awaiting renderer decision.`
    )
    win.webContents.send('hitl-request', payload)
  })
}

export function registerHitlIpc(): void {
  ipcMain.on('hitl-response', (_event, resp: HitlResponse) => {
    if (!resp || typeof resp.toolCallId !== 'string') return
    if (resp.status !== 'approved' && resp.status !== 'denied') return
    if (!resolvePendingApproval(resp.toolCallId, resp.status)) {
      console.warn(
        `[kieo] HITL response for unknown/settled approval "${resp.toolCallId}" — ignored.`
      )
    }
  })
}
