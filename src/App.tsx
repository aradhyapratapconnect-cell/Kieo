// src/App.tsx — KIEO-001 scaffold shell + KIEO-030 command bar.
// KIEO-041 wires the Memory view behind a minimal Home/Memory switch;
// full sidebar navigation lands in KIEO-051 (Epic F).
import { useState } from 'react'
import { useAgentStore } from './store/useAgentStore'
import CommandBar from './components/CommandBar'
import WakeWordToggle from './components/WakeWordToggle'
import MemoryView from './views/Memory'

type HomeView = 'home' | 'memory'

export default function App(): JSX.Element {
  const agentState = useAgentStore((s) => s.agentState)
  const wakeEnabled = useAgentStore((s) => s.wakeEnabled)
  const wakePhase = useAgentStore((s) => s.wakePhase)
  const wakeNote = useAgentStore((s) => s.wakeNote)
  const [view, setView] = useState<HomeView>('home')

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-primary">
      {/* Minimal top bar (spec 1.5): status left, settings gear right. */}
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-safe" />
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary">
            ONLINE
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            · {agentState}
          </span>
          {/* KIEO-032: visible wake indicator — never silent activation. */}
          {wakeEnabled && wakePhase !== 'off' && (
            <>
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  wakePhase === 'command' ? 'animate-pulse bg-primary-bright' : 'bg-primary'
                }`}
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary">
                {wakePhase === 'command' ? 'LISTENING' : 'SPOTTING'}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setView('home')}
            aria-pressed={view === 'home'}
            className={`rounded border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.06em] ${
              view === 'home'
                ? 'border-primary/60 text-primary-bright'
                : 'border-white/10 text-text-muted hover:text-text-secondary'
            }`}
          >
            Home
          </button>
          <button
            type="button"
            onClick={() => setView('memory')}
            aria-pressed={view === 'memory'}
            className={`rounded border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.06em] ${
              view === 'memory'
                ? 'border-primary/60 text-primary-bright'
                : 'border-white/10 text-text-muted hover:text-text-secondary'
            }`}
          >
            Memory
          </button>
          <button
            type="button"
            aria-label="Settings"
            className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-1 text-text-primary"
          >
            ⚙
          </button>
        </div>
      </header>

      {view === 'memory' ? (
        <main className="flex-1 overflow-y-auto">
          <MemoryView />
        </main>
      ) : (
        /* Center wordmark — emptiness is intentional (spec 1.5). */
        <main className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <h1 className="font-display text-[40px] font-bold leading-[48px]">Kieo</h1>
          <p className="text-[15px] text-text-secondary">
            Scaffold online — Tailwind + tokens + Zustand store wired.
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            Human-in-the-loop enabled · Local SQLite
          </p>
        </main>
      )}

      {/* Floating command bar: typed + voice input (KIEO-030). */}
      <footer className="flex flex-col items-center gap-2 px-4 pb-8">
        <WakeWordToggle />
        {wakeNote !== null && (
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary">
            {wakeNote}
          </p>
        )}
        <CommandBar />
      </footer>
    </div>
  )
}
