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
