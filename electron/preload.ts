// electron/preload.ts — Secure contextBridge API surface (KIEO-001).
// This is the ONLY bridge between renderer and main. Renderer code must never
// import or touch `electron` / `ipcRenderer` directly; it uses `window.kieo`.
import { contextBridge, ipcRenderer } from 'electron'
import type { HitlRequest, KieoApi } from '../shared/types'

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

  // Agent + settings bridges are stubbed here; real channels land in
  // KIEO-012 (agent) and KIEO-053 (settings).
  sendCommand: (text) => {
    ipcRenderer.send('agent-command', { text })
  },
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings-set', { key, value })
}

contextBridge.exposeInMainWorld('kieo', kieoApi)
