// electron/preload.ts — Secure contextBridge API surface (KIEO-001).
// This is the ONLY bridge between renderer and main. Renderer code must never
// import or touch `electron` / `ipcRenderer` directly; it uses `window.kieo`.
import { contextBridge, ipcRenderer } from 'electron'
import type { AgentState, HitlRequest, KieoApi, TtsSpeakPayload } from '../shared/types'

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

  // Agent + settings bridges are stubbed here; real channels land in
  // KIEO-012 (agent) and KIEO-053 (settings).
  sendCommand: (text) => {
    ipcRenderer.send('agent-command', { text })
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
