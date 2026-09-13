import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { MIC_DENIED_MESSAGE } from '../shared/types'
import { useAgentStore } from './store/useAgentStore'
import { createTtsPlayer, playWithWebAudio } from './voice/ttsPlayer'
import { configureWakeListener, setWakeListening } from './voice/wakeListener'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

// KIEO-012: agent loop transitions (main process) surface in the store, so
// every view (status dot, confirmation card, activity) can react to them.
window.kieo?.onAgentState((state) => {
  useAgentStore.getState().setAgentState(state)
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
