// shared/types.ts — Shared TypeScript types across main/renderer/agent-core (KIEO-001).
// Extended by later tickets (tool schemas in KIEO-011, loop state in KIEO-012, etc.).

export type AgentState =
  | 'IDLE'
  | 'LISTENING'
  | 'THINKING'
  | 'AWAITING_APPROVAL'
  | 'EXECUTING'
  | 'SPEAKING'

export type ToolClassification = 'read_only' | 'dangerous'

export type ApprovalStatus =
  | 'approved'
  | 'denied'
  | 'timeout'
  | 'auto_approved'

export type PermissionLevel = 'always_allow' | 'ask_every_time' | 'never_allow'

export interface HitlRequest {
  toolCallId: string
  toolName: string
  argsJson: string
  classification: ToolClassification
  /** Permissions-table key (KIEO-014) and card grouping (KIEO-052). */
  permissionActionType: string
}

export interface HitlResponse {
  toolCallId: string
  status: 'approved' | 'denied'
}

/** Whitelisted renderer API exposed via preload contextBridge. No raw ipcRenderer. */
export interface KieoApi {
  onHitlRequest: (cb: (req: HitlRequest) => void) => () => void
  sendHitlResponse: (resp: HitlResponse) => void
  sendCommand: (text: string) => void
  /** KIEO-012: loop state transitions for the Zustand store. */
  onAgentState: (cb: (state: AgentState) => void) => () => void
  getSettings: () => Promise<Record<string, unknown>>
  setSetting: (key: string, value: unknown) => Promise<{ ok: boolean }>
}

declare global {
  interface Window {
    kieo: KieoApi
  }
}
