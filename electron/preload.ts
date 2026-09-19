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
