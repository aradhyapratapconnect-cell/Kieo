// agent-core/permissions.ts — permissions-table policy resolution (KIEO-014).
//
// Translates `permissions` rows (Always Allow / Ask Every Time / Never Allow)
// into the HITL policy the approval flow enforces. Electron-free: usable from
// the main process and unit tests alike.
//
// Semantics (per ticket + Security & Access):
//   * No row for an action type -> 'ask' (ask_every_time is the default).
//   * never_allow -> 'deny', even for read_only tools: the agent cannot
//     bypass the permission table. (KIEO-013's "read-only skips approval"
//     still holds when unconfigured — skipping the *card* is not consent to
//     ignore an explicit Never Allow.)
//   * always_allow -> 'allow' (execute directly, still fully logged).
//   * ask_every_time -> 'ask' (full approval card flow).
import type { DatabaseHandle } from '../db/database'
import { getPermission } from '../db/tables'
import type { HitlPolicy, HitlPolicyContext } from './hitl'

/** The ResolveHitlPolicy implementation production injects (KIEO-013 seam). */
export function resolvePermissionPolicy(
  db: DatabaseHandle,
  ctx: HitlPolicyContext
): HitlPolicy {
  const row = getPermission(db, ctx.permissionActionType)
  if (!row) return 'ask'
  switch (row.level) {
    case 'never_allow':
      return 'deny'
    case 'always_allow':
      return 'allow'
    case 'ask_every_time':
    default:
      return 'ask'
  }
}

export interface PendingApprovalSnapshot {
  toolCallId: string
  permissionActionType: string
}

/**
 * Which pending approvals must die immediately because their action type is
 * now never_allow (Security edge: revocation mid-AWAITING_APPROVAL). Pure —
 * the IPC layer snapshots its pending map, calls this, and resolves the
 * returned ids as denied.
 */
export function findRevokedPendingApprovals(
  db: DatabaseHandle,
  pendings: PendingApprovalSnapshot[]
): string[] {
  return pendings
    .filter((p) => {
      const row = getPermission(db, p.permissionActionType)
      return row?.level === 'never_allow'
    })
    .map((p) => p.toolCallId)
}
