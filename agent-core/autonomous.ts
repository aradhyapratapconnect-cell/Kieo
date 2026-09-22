// agent-core/autonomous.ts — session-scoped autonomous mode (KIEO-060, post-MVP).
//
// What makes this distinct from blanket `always_allow` (per the ticket) is
// SESSION scoping: the ON switch lives only in main-process memory and
// resets to OFF on every launch, while the *scope* (which action types may
// auto-run) persists in settings. Arming it is an explicit per-session act.
//
// Safety invariants (pinned by test):
//   * Off by default — a fresh process never auto-runs anything.
//   * `never_allow` always wins, even for in-scope actions with mode on.
//   * Out-of-scope actions fall through to the normal permission policy.
//   * Autonomous executions still flow through executeToolWithHITL()'s
//     `allow` path, so they are fully logged as `auto_approved`.
import type { DatabaseHandle } from '../db/database'
import { getSetting, setSetting } from '../db/tables'
import type { ToolClassification } from '../shared/types'
import type { HitlPolicy } from './hitl'
import type { ToolRegistry } from './tools/registry'

export const SETTING_AUTONOMOUS_ACTIONS = 'autonomous_actions'

export type AutonomousModelErrorCode = 'unknown-action'

export class AutonomousModelError extends Error {
  readonly code: AutonomousModelErrorCode

  constructor(code: AutonomousModelErrorCode, message: string) {
    super(message)
    this.name = 'AutonomousModelError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Session flag — main-process memory only, OFF at every launch by construction
// ---------------------------------------------------------------------------

let sessionEnabled = false

/** True only after an explicit in-session enable (resets on restart). */
export function isAutonomousEnabled(): boolean {
  return sessionEnabled
}

export function setAutonomousEnabled(enabled: boolean): boolean {
  sessionEnabled = enabled
  return sessionEnabled
}

// ---------------------------------------------------------------------------
// Scope — persisted action-type allowlist (validated against the registry)
// ---------------------------------------------------------------------------

export interface AutonomousActionState {
  actionType: string
  classification: ToolClassification
  inScope: boolean
}

/** Raw scope list as stored (sorted, deduped, registry-validated on write). */
export function getAutonomousScope(db: DatabaseHandle): string[] {
  const raw = getSetting<string[]>(db, SETTING_AUTONOMOUS_ACTIONS)
  return Array.isArray(raw) ? raw.filter((a) => typeof a === 'string') : []
}

/** Replace the scope; unknown action types throw (no silent typos). */
export function setAutonomousScope(
  db: DatabaseHandle,
  registry: ToolRegistry,
  actions: string[]
): string[] {
  const known = new Set(registry.listTools().map((t) => t.permissionActionType))
  for (const action of actions) {
    if (!known.has(action)) {
      throw new AutonomousModelError(
        'unknown-action',
        `Unknown action type "${action}" — it is not in the tool registry.`
      )
    }
  }
  const scope = [...new Set(actions)].sort()
  setSetting(db, SETTING_AUTONOMOUS_ACTIONS, scope)
  return scope
}

/** Every registry action with its classification + in-scope flag (for the UI). */
export function listAutonomousActions(
  db: DatabaseHandle,
  registry: ToolRegistry
): AutonomousActionState[] {
  const scope = new Set(getAutonomousScope(db))
  return registry.listTools().map((t) => ({
    actionType: t.permissionActionType,
    classification: t.classification,
    inScope: scope.has(t.permissionActionType)
  }))
}

// ---------------------------------------------------------------------------
// Policy composition — applied AFTER the base permission policy so deny wins
// ---------------------------------------------------------------------------

/**
 * Upgrade a base policy with autonomy: `deny` is returned untouched
 * (Never Allow always wins); `ask` becomes `allow` only when the session is
 * armed AND the action is in scope. Pure — unit-tested matrix below.
 */
export function applyAutonomy(
  base: HitlPolicy,
  sessionArmed: boolean,
  inScope: boolean
): HitlPolicy {
  if (base === 'deny') return 'deny'
  if (base === 'ask' && sessionArmed && inScope) return 'allow'
  return base
}
