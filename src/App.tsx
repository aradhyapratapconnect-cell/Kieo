// src/App.tsx — KIEO-001 scaffold shell + KIEO-030 command bar.
// KIEO-041/042 wire Memory + Activity/Dashboard behind a minimal view
// switch; full sidebar navigation lands in KIEO-051 (Epic F).
import { useState } from 'react'
import { useAgentStore } from './store/useAgentStore'
import CommandBar from './components/CommandBar'
import HomeScreen from './components/HomeScreen'
import WakeWordToggle from './components/WakeWordToggle'
import ActivityView from './views/Activity'
import DashboardView from './views/Dashboard'
import MemoryView from './views/Memory'

type HomeView = 'home' | 'memory' | 'activity' | 'dashboard'

const NAV_ITEMS: Array<{ id: HomeView; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'memory', label: 'Memory' },
  { id: 'activity', label: 'Activity' },
  { id: 'dashboard', label: 'Dashboard' }
]

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
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              aria-pressed={view === item.id}
              className={`rounded border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.06em] ${
                view === item.id
                  ? 'border-primary/60 text-primary-bright'
                  : 'border-white/10 text-text-muted hover:text-text-secondary'
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            aria-label="Settings"
            className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-1 text-text-primary"
          >
            ⚙
          </button>
        </div>
      </header>

      {view !== 'home' ? (
        <main className="flex-1 overflow-y-auto">
          {view === 'memory' && <MemoryView />}
          {view === 'activity' && <ActivityView />}
          {view === 'dashboard' && <DashboardView />}
        </main>
      ) : (
        <main className="flex-1 overflow-hidden">
          <HomeScreen />
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
