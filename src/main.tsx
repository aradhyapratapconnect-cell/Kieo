import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { useAgentStore } from './store/useAgentStore'
import { createTtsPlayer, playWithWebAudio } from './voice/ttsPlayer'

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

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
