import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { MIC_DENIED_MESSAGE, type AgentState } from '../shared/types'
import { useAgentStore } from './store/useAgentStore'
import { createTtsPlayer, playWithWebAudio } from './voice/ttsPlayer'
import {
  captureApprovalUtterance,
  createApprovalChannel
} from './voice/approvalChannel'
import { configureWakeListener, setWakeListening, setWakePaused } from './voice/wakeListener'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

// KIEO-033: voice HITL approvals. Spoken yes/no resolves the pending card
// through hitl-response; anything else queues as a command and flushes when
// the loop settles. The channel pauses wake spotting while it holds a card.
const approvalChannel = createApprovalChannel({
  capture: () => captureApprovalUtterance(),
  transcribeAudio: (pcm, sampleRate) => window.kieo.transcribeAudio(pcm, sampleRate),
  sendResponse: (resp) => window.kieo.sendHitlResponse(resp),
  submitCommand: (text) => window.kieo.sendCommand(text),
  onNotice: (text) => {
    useAgentStore.getState().setWakeNote(text)
  },
  setWakePaused
})
window.kieo?.onHitlRequest((req) => {
  approvalChannel.onApprovalRequested(req.toolCallId)
})
const forwardAgentState = (state: AgentState): void => {
  useAgentStore.getState().setAgentState(state)
  approvalChannel.onAgentState(state)
}
window.kieo?.onAgentState(forwardAgentState)

// KIEO-050: finished-turn text for the home inline response (no view change).
window.kieo?.onAgentMessage((msg) => {
  useAgentStore.getState().setLastMessage(msg)
})

// KIEO-031: synthesized speech playback. SPEAKING shows while audio plays;
// the store reverts only from SPEAKING so a concurrent loop state is never
// clobbered.
const ttsPlayer = createTtsPlayer({
  play: playWithWebAudio,
  onActiveChange: (active) => {
    const store = useAgentStore.getState()
    if (active) {
      store.setAgentState('SPEAKING')
    } else if (store.agentState === 'SPEAKING') {
      store.setAgentState('IDLE')
    }
  }
})
window.kieo?.onTtsSpeak((payload) => {
  ttsPlayer.enqueue(payload.pcm, payload.sampleRate)
})

// KIEO-032: background wake-word listening. Callbacks bridge the listener to
// the store; the toggle owns user intent, this owns lifecycle.
configureWakeListener({
  onPhase: (phase) => {
    useAgentStore.getState().setWakePhase(phase)
  },
  onCommandSent: (transcript) => {
    const short = transcript.length > 90 ? `${transcript.slice(0, 90)}…` : transcript
    useAgentStore.getState().setWakeNote(`Heard: “${short}” — sent.`)
  },
  onNotice: (text) => {
    useAgentStore.getState().setWakeNote(text)
  },
  onError: (message) => {
    // Mic died mid-session: reflect reality (off) instead of fake listening.
    const store = useAgentStore.getState()
    store.setWakeEnabled(false)
    store.setWakePhase('off')
    store.setWakeNote(message)
    void setWakeListening(false)
  }
})
// Resume previous session's choice: the toggle stays the explicit gate, this
// only re-attaches a persisted opt-in (and self-corrects if the mic is gone).
if (useAgentStore.getState().wakeEnabled) {
  void setWakeListening(true).then((ok) => {
    if (!ok) {
      const store = useAgentStore.getState()
      store.setWakeEnabled(false)
      store.setWakePhase('off')
      store.setWakeNote(MIC_DENIED_MESSAGE)
    }
  })
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
