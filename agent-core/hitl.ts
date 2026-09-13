// agent-core/hitl.ts — Human-in-the-loop approval logic (KIEO-013).
//
// Pure main-process logic; the Electron IPC transport is injected as
// `requestApproval` (production: electron/ipc/hitl.ts, tests: scripted fakes),
// so this module never imports 'electron' and stays unit-testable under Node.
//
// Flow per dangerous tool call:
//   1. Look up the definition (unknown tools are denied immediately — never
//      executed, never shown an approval card).
//   2. Policy check first: explicit never_allow denies ANY tool class without
//      a card (the agent cannot bypass the permission table). Read-only tools
//      otherwise skip approval entirely and execute at once.
//   3. Dangerous tools consult `resolvePolicy` (default: always ask;
//      production injects the permissions-table version in KIEO-014) and,
//      when asking, pause for exactly one resolved decision: approved,
//      denied, or timeout. A post-approval recheck closes the revoke race.
//   4. Approved -> execute, return the result. Denied/timeout -> return a safe,
//      LLM-summarizable error result WITHOUT executing anything.
//   5. Every outcome is written to `tool_execution_log` (needs the assistant
//      `messageId`; dispatch creates the rows, see electron/ipc/agent.ts).
//
// Golden-rule note: this function resolves each call fully before returning —
// the loop (KIEO-012) never dispatches the next call until this promise
// settles, so approvals can't overlap by construction.
import type { DatabaseHandle } from '../db/database'
import { logToolExecution, updateMessage } from '../db/tables'
import type { ToolRegistry } from './tools/registry'
import type { LoopToolExecutor } from './loop'
import type { ApprovalStatus, ToolClassification } from '../shared/types'

export type HitlDecision = 'approved' | 'denied' | 'timeout'

export interface HitlApprovalRequest {
  toolCallId: string
  toolName: string
  input: unknown
  classification: ToolClassification
  permissionActionType: string
}

/**
 * Ask the user (approval card now, voice confirmation in KIEO-033) and
 * resolve with exactly one decision. Implementations must always resolve —
 * timeouts included — and must never throw for a plain denial.
 */
export type RequestApproval = (req: HitlApprovalRequest) => Promise<HitlDecision>

export type HitlPolicy = 'ask' | 'allow' | 'deny'

export interface HitlPolicyContext {
  toolName: string
  classification: ToolClassification
  permissionActionType: string
}

/**
 * Decides whether a tool call needs the approval UI. Default asks every
 * time; production injects the permissions-table version (KIEO-014:
 * never_allow -> deny, always_allow -> allow). Read-only tools still skip the
 * *card*, but an explicit deny from this resolver blocks them too.
 */
export type ResolveHitlPolicy = (ctx: HitlPolicyContext) => HitlPolicy

const defaultResolvePolicy: ResolveHitlPolicy = () => 'ask'

export interface ExecuteToolWithHitlInput {
  toolCallId: string
  toolName: string
  input: unknown
  /** Assistant message row the tool call belongs to (FK for the log). */
  messageId: string
}

export interface ExecuteToolWithHitlDeps {
  db: DatabaseHandle
  registry: ToolRegistry
  requestApproval: RequestApproval
  /** Implementation dispatch (agent-core/tools/dispatch.ts in production). */
  executeTool: (toolName: string, input: unknown) => Promise<unknown>
  resolvePolicy?: ResolveHitlPolicy
  /** Approval timeout behind `requestApproval`, for accurate messages. Default 60000. */
  timeoutMs?: number
}

export interface HitlOutcome {
  status: ApprovalStatus
  /** LLM-summarizable result: value, denial, timeout, or execution error. */
  result: unknown
  executed: boolean
}

export const HITL_DENIED_MESSAGE =
  'The user denied this action. Acknowledge it briefly and do not retry it unless the user explicitly asks again.'

export function hitlTimeoutMessage(timeoutMs: number): string {
  const secs = Math.max(1, Math.round(timeoutMs / 1000))
  return `I didn't hear back within ${secs} seconds, so I didn't run that. Let me know if you'd still like me to.`
}

function availableToolNames(registry: ToolRegistry): string {
  return registry
    .listTools()
    .map((t) => t.name)
    .join(', ')
}

export async function executeToolWithHITL(
  input: ExecuteToolWithHitlInput,
  deps: ExecuteToolWithHitlDeps
): Promise<HitlOutcome> {
  const { db, registry } = deps
  const resolvePolicy = deps.resolvePolicy ?? defaultResolvePolicy

  const def = registry.getTool(input.toolName)
  if (!def) {
    const result = {
      status: 'denied' as const,
      reason: `Unknown tool "${input.toolName}". Available tools: ${availableToolNames(registry)}.`
    }
    // Unknown tools are logged dangerous+denied: never executed, by default.
    logToolExecution(db, {
      messageId: input.messageId,
      toolName: input.toolName,
      args: input.input,
      classification: 'dangerous',
      approvalStatus: 'denied',
      result
    })
    return { status: 'denied', result, executed: false }
  }

  const policy = resolvePolicy({
    toolName: def.name,
    classification: def.classification,
    permissionActionType: def.permissionActionType
  })

  // Explicit never_allow denies immediately — no card, no execution, no LLM
  // round-trip needed. Applies to read_only tools as well: skipping the
  // approval *card* is not consent to ignore an explicit Never Allow.
  if (policy === 'deny') {
    const result = {
      status: 'denied' as const,
      reason: `Policy forbids "${def.name}" (permission level never_allow).`
    }
    logToolExecution(db, {
      messageId: input.messageId,
      toolName: input.toolName,
      args: input.input,
      classification: def.classification,
      approvalStatus: 'denied',
      result
    })
    return { status: 'denied', result, executed: false }
  }

  // Read-only tools skip the approval flow entirely (ticket AC) and are
  // logged as auto_approved: executed under standing policy, no prompt.
  // KIEO-014's always_allow shares this status for the same reason.
  if (def.classification === 'read_only') {
    const result = await runImplementation(input.toolName, input.input, deps.executeTool)
    logToolExecution(db, {
      messageId: input.messageId,
      toolName: input.toolName,
      args: input.input,
      classification: def.classification,
      approvalStatus: 'auto_approved',
      result
    })
    return { status: 'auto_approved', result, executed: true }
  }

  if (policy === 'allow') {
    const result = await runImplementation(input.toolName, input.input, deps.executeTool)
    logToolExecution(db, {
      messageId: input.messageId,
      toolName: input.toolName,
      args: input.input,
      classification: def.classification,
      approvalStatus: 'auto_approved',
      result
    })
    return { status: 'auto_approved', result, executed: true }
  }

  const decision = await deps.requestApproval({
    toolCallId: input.toolCallId,
    toolName: def.name,
    input: input.input,
    classification: def.classification,
    permissionActionType: def.permissionActionType
  })

  if (decision === 'approved') {
    // Revoked between approval and execution? Treat as denied (defense in
    // depth — the active path is reevaluatePendingApprovals, which denies the
    // pending card immediately; this closes the residual race).
    if (
      resolvePolicy({
        toolName: def.name,
        classification: def.classification,
        permissionActionType: def.permissionActionType
      }) === 'deny'
    ) {
      const result = {
        status: 'denied' as const,
        reason: `Permission for "${def.name}" was revoked (never_allow) after approval, before execution.`
      }
      logToolExecution(db, {
        messageId: input.messageId,
        toolName: input.toolName,
        args: input.input,
        classification: def.classification,
        approvalStatus: 'denied',
        result
      })
      return { status: 'denied', result, executed: false }
    }
    const result = await runImplementation(input.toolName, input.input, deps.executeTool)
    logToolExecution(db, {
      messageId: input.messageId,
      toolName: input.toolName,
      args: input.input,
      classification: def.classification,
      approvalStatus: 'approved',
      result
    })
    return { status: 'approved', result, executed: true }
  }

  const result =
    decision === 'timeout'
      ? {
          status: 'timeout' as const,
          message: hitlTimeoutMessage(deps.timeoutMs ?? 60_000)
        }
      : { status: 'denied' as const, message: HITL_DENIED_MESSAGE }
  logToolExecution(db, {
    messageId: input.messageId,
    toolName: input.toolName,
    args: input.input,
    classification: def.classification,
    approvalStatus: decision,
    result
  })
  return { status: decision, result, executed: false }
}

/**
 * Implementation errors (file not found, not-implemented, spawn failure) are
 * captured as error results per the Error Handling Guide — the turn survives
 * and the LLM explains the failure. Only executor-internal bugs propagate.
 */
async function runImplementation(
  toolName: string,
  input: unknown,
  executeTool: ExecuteToolWithHitlDeps['executeTool']
): Promise<unknown> {
  try {
    return await executeTool(toolName, input)
  } catch (err) {
    return {
      status: 'error' as const,
      toolName,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

// ---------------------------------------------------------------------------
// Loop adapter — plugs the approval flow into runAgentLoop (KIEO-012).
// Also maintains the turn's assistant message row: tool_call_json accumulates
// every tool call of the turn (single-row-per-turn until KIEO-040 refines it).
// ---------------------------------------------------------------------------

export interface CreateHitlExecutorDeps extends ExecuteToolWithHitlDeps {
  /** Assistant message row for this turn (created by dispatch). */
  messageId: string
}

export function createHitlExecutor(deps: CreateHitlExecutorDeps): LoopToolExecutor {
  const seenCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = []
  return async (req, ctx) => {
    seenCalls.push({ toolCallId: req.toolCallId, toolName: req.toolName, input: req.input })
    updateMessage(deps.db, deps.messageId, {
      toolCallJson: JSON.stringify(seenCalls)
    })
    // KIEO-033: surface the approval gate as agent state so the UI (card,
    // voice approval channel, activity views) can react to it. The inner
    // requestApproval resolves the card/voice/timeout decision.
    const reportingApproval: RequestApproval = async (approvalReq) => {
      ctx.reportState('AWAITING_APPROVAL')
      try {
        return await deps.requestApproval(approvalReq)
      } finally {
        ctx.reportState('EXECUTING')
      }
    }
    const outcome = await executeToolWithHITL(
      {
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        input: req.input,
        messageId: deps.messageId
      },
      { ...deps, requestApproval: reportingApproval }
    )
    return outcome.result
  }
}
