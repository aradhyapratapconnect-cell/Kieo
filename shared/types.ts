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

/** KIEO-040: conversation/message DTOs (mirror db/tables rows, renderer-safe). */
export interface ConversationDto {
  id: string
  title: string
  created_at: number
  updated_at: number
}

export type ConversationMessageRole = 'user' | 'assistant' | 'tool'

export interface ConversationMessageDto {
  id: string
  conversation_id: string
  role: ConversationMessageRole
  content: string
  tool_call_json: string | null
  created_at: number
}

/** KIEO-041: memory fact DTO (mirrors db/tables MemoryFactRow). */
export interface MemoryFactDto {
  id: string
  fact: string
  source_message_id: string | null
  created_at: number
  edited_by_user: number
}

/** KIEO-042: one tool_execution_log row (every field the UI may show). */
export interface ToolExecutionLogDto {
  id: string
  message_id: string
  tool_name: string
  args_json: string
  classification: ToolClassification
  approval_status: ApprovalStatus
  result_json: string | null
  created_at: number
}

export interface ToolLogsFilter {
  classification?: ToolClassification
  approvalStatus?: ApprovalStatus
  limit?: number
}

/** KIEO-050: assistant turn result pushed to the home inline response. */
export interface AgentMessageDto {
  conversationId: string | null
  text: string
  isError: boolean
}

/** KIEO-053 Settings: one permission row (level + whether it is the default). */
export interface PermissionStateDto {
  actionType: string
  level: PermissionLevel
  isDefault: boolean
}

/** KIEO-053 Settings: provider snapshot — flags only, never key material. */
export interface ProviderStateDto {
  id: string
  label: string
  defaultModel: string
  activeModel: string
  hasModelOverride: boolean
  keySaved: boolean
  isActive: boolean
}

export interface ProvidersSnapshotDto {
  activeProviderId: string
  providers: ProviderStateDto[]
}

/** KIEO-060 autonomous mode: session arming + per-action scope. */
export interface AutonomousActionDto {
  actionType: string
  classification: ToolClassification
  inScope: boolean
}

export interface AutonomySnapshotDto {
  /** Session-only: always false on fresh launch by construction. */
  enabled: boolean
  scope: string[]
  actions: AutonomousActionDto[]
}

/** KIEO-063: one drop-validation result per input path. */
export interface PathValidationDto {
  input: string
  ok: boolean
  resolved: string | null
}

/** Clamp + validate a renderer-supplied filter (shared by main + tests). */
export function normalizeToolLogsFilter(
  raw?: Partial<ToolLogsFilter> | null
): Required<Pick<ToolLogsFilter, 'limit'>> & Pick<ToolLogsFilter, 'classification' | 'approvalStatus'> {
  const classification =
    raw?.classification === 'read_only' || raw?.classification === 'dangerous'
      ? raw.classification
      : undefined
  const approvalStatus =
    raw?.approvalStatus === 'approved' ||
    raw?.approvalStatus === 'denied' ||
    raw?.approvalStatus === 'timeout' ||
    raw?.approvalStatus === 'auto_approved'
      ? raw.approvalStatus
      : undefined
  const limit =
    typeof raw?.limit === 'number' && Number.isFinite(raw.limit)
      ? Math.max(1, Math.min(500, Math.floor(raw.limit)))
      : 200
  return { classification, approvalStatus, limit }
}

/** Whitelisted renderer API exposed via preload contextBridge. No raw ipcRenderer. */
export interface KieoApi {
  onHitlRequest: (cb: (req: HitlRequest) => void) => () => void
  sendHitlResponse: (resp: HitlResponse) => void
  /** KIEO-040: optional conversationId continues a past conversation. */
  sendCommand: (text: string, conversationId?: string) => void
  /** Invoke variant that resolves with the target conversation id. */
  sendCommandAsync: (
    text: string,
    conversationId?: string
  ) => Promise<{ conversationId: string | null }>
  /** KIEO-040 read path for history restore + Conversations view (KIEO-054). */
  listConversations: (limit?: number) => Promise<ConversationDto[]>
  getConversation: (id: string) => Promise<ConversationDto | null>
  listMessages: (conversationId: string, limit?: number) => Promise<ConversationMessageDto[]>
  /** KIEO-041 Memory view: list/edit/delete durable facts. */
  listMemoryFacts: () => Promise<MemoryFactDto[]>
  updateMemoryFact: (id: string, fact: string) => Promise<{ ok: boolean }>
  deleteMemoryFact: (id: string) => Promise<{ ok: boolean }>
  /** KIEO-042 Activity/Dashboard: chronological tool history + live updates. */
  listToolLogs: (filter?: ToolLogsFilter) => Promise<ToolExecutionLogDto[]>
  onToolLogsUpdated: (cb: () => void) => () => void
  /** KIEO-050 inline home response: one push per finished turn (or failure). */
  onAgentMessage: (cb: (msg: AgentMessageDto) => void) => () => void
  /** KIEO-053 Settings: permissions (backed by the permissions table). */
  listPermissions: () => Promise<PermissionStateDto[]>
  setPermission: (
    actionType: string,
    level: PermissionLevel
  ) => Promise<{ ok: boolean; revoked?: string[]; error?: string }>
  /** KIEO-053 Settings: providers, models, and keychain-backed keys. */
  describeProviders: () => Promise<ProvidersSnapshotDto>
  setActiveProvider: (providerId: string) => Promise<{ ok: boolean; error?: string }>
  setProviderModel: (
    providerId: string,
    model: string
  ) => Promise<{ ok: boolean; activeModel?: string; error?: string }>
  saveProviderKey: (
    providerId: string,
    key: string
  ) => Promise<{ ok: boolean; error?: string }>
  deleteProviderKey: (
    providerId: string
  ) => Promise<{ ok: boolean; deleted?: boolean; error?: string }>
  /** KIEO-061 cloud sync (opt-in; disabled/signed-out by default). */
  getSyncStatus: () => Promise<{
    signedIn: boolean
    userId: string | null
    email: string | null
    urlConfigured: boolean
  }>
  getSyncConfig: () => Promise<{ url: string | null }>
  setSyncConfig: (url: string, anonKey?: string) => Promise<{ ok: boolean; url?: string | null; error?: string }>
  syncSignIn: (email: string, password: string) => Promise<{ ok: boolean; userId?: string; email?: string | null; error?: string }>
  syncSignOut: () => Promise<{ ok: boolean }>
  syncNow: () => Promise<{
    ok: boolean
    pushed?: { settings: number; permissions: number; facts: number }
    pulled?: { settings: number; permissions: number; facts: number }
    error?: string
  }>
  /** KIEO-063 drop validation: one result per input path, order-preserved. */
  validatePaths: (paths: string[]) => Promise<PathValidationDto[]>

  /** KIEO-062 owner voice (enrollment + approvals-only gate). */
  getVoiceProfileStatus: () => Promise<{
    enrolled: boolean
    samples: number
    threshold: number
    ownerOnly: boolean
    targetSamples: number
  }>
  setVoiceOwnerOnly: (enabled: boolean) => Promise<{ ok: boolean; ownerOnly?: boolean; error?: string }>
  voiceEnrollAdd: (
    pcm: ArrayBuffer,
    sampleRate: number
  ) => Promise<
    | { ok: true; samples: number; consistency: number | null }
    | { ok: false; code: string; message: string }
  >
  voiceEnrollCommit: () => Promise<{ ok: boolean; samples?: number; code?: string; message?: string; error?: string }>
  voiceEnrollReset: () => Promise<{ ok: boolean }>
  voiceVerify: (
    pcm: ArrayBuffer,
    sampleRate: number
  ) => Promise<
    | { ok: true; match: boolean; score: number }
    | { ok: false; code: string; message: string }
  >
  /** KIEO-060 autonomous mode (experimental, session-scoped). */
  getAutonomy: () => Promise<AutonomySnapshotDto>
  setAutonomyEnabled: (enabled: boolean) => Promise<{ ok: boolean; enabled?: boolean; error?: string }>
  setAutonomyScope: (actions: string[]) => Promise<{ ok: boolean; scope?: string[]; error?: string }>
  /** KIEO-012: loop state transitions for the Zustand store. */
  onAgentState: (cb: (state: AgentState) => void) => () => void
  /** KIEO-030: ship resampled PCM to main for local transcription. */
  transcribeAudio: (pcm: ArrayBuffer, sampleRate: number) => Promise<SttTranscribeResult>
  /** KIEO-031: synthesized speech PCM from main for playback. */
  onTtsSpeak: (cb: (payload: TtsSpeakPayload) => void) => () => void
  getSettings: () => Promise<Record<string, unknown>>
  setSetting: (key: string, value: unknown) => Promise<{ ok: boolean }>
}

// ---------------------------------------------------------------------------
// Voice contract (KIEO-030). Lives here — not in agent-core — so the renderer
// can import messages without dragging main-process modules into its bundle.
// ---------------------------------------------------------------------------

export type SttErrorCode =
  | 'no-speech'
  | 'download-failed'
  | 'not-installed'
  | 'failed'

export type SttTranscribeResult =
  | { ok: true; transcript: string }
  | { ok: false; code: SttErrorCode; message: string }

/** User-facing copy per code (Error Handling Guide wording for no-speech). */
export const STT_USER_MESSAGE: Record<SttErrorCode, string> = {
  'no-speech': "I didn't catch that — you can type your command instead.",
  'download-failed':
    "Couldn't download the speech model — check your connection once, then voice works offline. Or just type your command.",
  'not-installed':
    'Voice engine unavailable on this machine — you can still type every command.',
  failed: 'Voice transcription failed — you can type your command instead.'
}

/** Renderer-side mic capture failure (never reaches main). Text-only fallback. */
export const MIC_DENIED_MESSAGE =
  'Microphone unavailable — Kieo is in text-only mode. Check the OS microphone permission to enable voice.'

// ---------------------------------------------------------------------------
// Speech playback (KIEO-031). Main synthesizes; renderer plays.
// ---------------------------------------------------------------------------

/** PCM payload for one utterance (Kokoro: 24kHz mono float32). */
export interface TtsSpeakPayload {
  pcm: ArrayBuffer
  sampleRate: number
}

declare global {
  interface Window {
    kieo: KieoApi
  }
}
