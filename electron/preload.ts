// electron/preload.ts — Secure contextBridge API surface (KIEO-001).
// This is the ONLY bridge between renderer and main. Renderer code must never
// import or touch `electron` / `ipcRenderer` directly; it uses `window.kieo`.
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentMessageDto,
  AgentState,
  HitlRequest,
  KieoApi,
  TtsSpeakPayload
} from '../shared/types'

const kieoApi: KieoApi = {
  // HITL approval channel (full duplex impl lands in KIEO-013 / KIEO-052).
  onHitlRequest: (cb) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: HitlRequest
    ): void => {
      cb(payload)
    }
    ipcRenderer.on('hitl-request', listener)
    return () => {
      ipcRenderer.removeListener('hitl-request', listener)
    }
  },
  sendHitlResponse: (resp) => {
    ipcRenderer.send('hitl-response', resp)
  },

  // KIEO-050: finished-turn text for the home inline response.
  onAgentMessage: (cb) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: AgentMessageDto
    ): void => {
      cb(payload)
    }
    ipcRenderer.on('agent-message', listener)
    return () => {
      ipcRenderer.removeListener('agent-message', listener)
    }
  },

  // KIEO-012: loop state transitions -> renderer Zustand store.
  onAgentState: (cb) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: AgentState
    ): void => {
      cb(state)
    }
    ipcRenderer.on('agent-state', listener)
    return () => {
      ipcRenderer.removeListener('agent-state', listener)
    }
  },

  // Agent commands: fire-and-forget for the home bar, invoke variant when
  // the caller needs the conversation id (KIEO-040 continuation).
  sendCommand: (text, conversationId) => {
    ipcRenderer.send('agent-command', { text, conversationId })
  },
  sendCommandAsync: (text, conversationId) =>
    ipcRenderer.invoke('agent-send', { text, conversationId }),
  // KIEO-040 history read path (restart restore + Conversations view).
  listConversations: (limit) => ipcRenderer.invoke('conversations-list', { limit }),
  getConversation: (id) => ipcRenderer.invoke('conversation-get', { id }),
  listMessages: (conversationId, limit) =>
    ipcRenderer.invoke('messages-list', { conversationId, limit }),
  // KIEO-041 Memory view.
  listMemoryFacts: () => ipcRenderer.invoke('memory-list'),
  updateMemoryFact: (id, fact) => ipcRenderer.invoke('memory-update', { id, fact }),
  deleteMemoryFact: (id) => ipcRenderer.invoke('memory-delete', { id }),
  // KIEO-053 Settings.
  listPermissions: () => ipcRenderer.invoke('permissions-list'),
  setPermission: (actionType, level) =>
    ipcRenderer.invoke('permissions-set', { actionType, level }),
  describeProviders: () => ipcRenderer.invoke('providers-describe'),
  setActiveProvider: (providerId) =>
    ipcRenderer.invoke('providers-set-active', { providerId }),
  setProviderModel: (providerId, model) =>
    ipcRenderer.invoke('providers-set-model', { providerId, model }),
  saveProviderKey: (providerId, key) =>
    ipcRenderer.invoke('providers-save-key', { providerId, key }),
  deleteProviderKey: (providerId) =>
    ipcRenderer.invoke('providers-delete-key', { providerId }),
  // KIEO-061 cloud sync (opt-in).
  getSyncStatus: () => ipcRenderer.invoke('sync-status'),
  getSyncConfig: () => ipcRenderer.invoke('sync-config-get'),
  setSyncConfig: (url, anonKey) => ipcRenderer.invoke('sync-config-set', { url, anonKey }),
  syncSignIn: (email, password) => ipcRenderer.invoke('sync-signin', { email, password }),
  syncSignOut: () => ipcRenderer.invoke('sync-signout'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  // KIEO-062 owner voice (engine may be unprovisioned — calls fail typed).
  getVoiceProfileStatus: () => ipcRenderer.invoke('voice-profile-status'),
  setVoiceOwnerOnly: (enabled) => ipcRenderer.invoke('voice-owner-set', { enabled }),
  voiceEnrollAdd: (pcm, sampleRate) =>
    ipcRenderer.invoke('voice-enroll-add', { pcm, sampleRate }),
  voiceEnrollCommit: () => ipcRenderer.invoke('voice-enroll-commit'),
  voiceEnrollReset: () => ipcRenderer.invoke('voice-enroll-reset'),
  voiceVerify: (pcm, sampleRate) => ipcRenderer.invoke('voice-verify', { pcm, sampleRate }),
  // KIEO-060 autonomous mode.
  getAutonomy: () => ipcRenderer.invoke('autonomy-get'),
  setAutonomyEnabled: (enabled) => ipcRenderer.invoke('autonomy-set-enabled', { enabled }),
  setAutonomyScope: (actions) => ipcRenderer.invoke('autonomy-set-scope', { actions }),
  // KIEO-042 Activity/Dashboard.
  listToolLogs: (filter) => ipcRenderer.invoke('tool-logs-list', filter ?? {}),
  onToolLogsUpdated: (cb) => {
    const listener = (): void => {
      cb()
    }
    ipcRenderer.on('tool-logs-updated', listener)
    return () => {
      ipcRenderer.removeListener('tool-logs-updated', listener)
    }
  },

  // KIEO-030: ship resampled PCM to main for local transcription.
  transcribeAudio: (pcm, sampleRate) =>
    ipcRenderer.invoke('stt-transcribe', { pcm, sampleRate }),

  // KIEO-031: synthesized speech PCM from main for playback.
  onTtsSpeak: (cb) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: TtsSpeakPayload
    ): void => {
      cb(payload)
    }
    ipcRenderer.on('tts-speak', listener)
    return () => {
      ipcRenderer.removeListener('tts-speak', listener)
    }
  },
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings-set', { key, value })
}

contextBridge.exposeInMainWorld('kieo', kieoApi)
