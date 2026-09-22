// src/App.tsx — KIEO-001 scaffold shell + KIEO-030 command bar.
// KIEO-051 owns the navigation shell: distraction-free home (no sidebar,
// quick links in the top bar) + persistent left sidebar on every other view.
// Full Conversations/Settings bodies land in KIEO-054/053.
import { useState } from 'react'
import { useAgentStore } from './store/useAgentStore'
import CommandBar from './components/CommandBar'
import { ConfirmationOverlay } from './components/ConfirmationCard'
import HomeScreen from './components/HomeScreen'
import Sidebar from './components/Sidebar'
import WakeWordToggle from './components/WakeWordToggle'
import { NAV_ITEMS, isSidebarVisible, type ViewId } from './components/nav'
import ActivityView from './views/Activity'
import ConversationsView from './views/Conversations'
import DashboardView from './views/Dashboard'
import MemoryView from './views/Memory'
import SettingsView from './views/Settings'

export default function App(): JSX.Element {
  const agentState = useAgentStore((s) => s.agentState)
  const wakeEnabled = useAgentStore((s) => s.wakeEnabled)
  const wakePhase = useAgentStore((s) => s.wakePhase)
  const wakeNote = useAgentStore((s) => s.wakeNote)
  const [view, setView] = useState<ViewId>('home')
  const autonomyEnabled = useAgentStore((s) => s.autonomyEnabled)

  return (
    <div className="flex h-full flex-col bg-bg-base text-text-primary">
      {/* Minimal top bar (spec 1.5): status left, nav right. */}
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-safe" />
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary">
            ONLINE
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            · {agentState}
          </span>
          {/* KIEO-060: unmissable while session autonomy is armed. */}
          {autonomyEnabled && (
            <span
              role="status"
              title="Autonomous mode armed — in-scope actions run without asking"
              className="rounded border border-caution/60 bg-caution/10 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-caution"
            >
              Auto
            </span>
          )}
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
          {view === 'home' ? (
            /* Home stays chrome-light: quick links instead of the sidebar. */
            NAV_ITEMS.map((item) => (
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
            ))
          ) : (
            <button
              type="button"
              onClick={() => setView('settings')}
              aria-label="Settings"
              aria-pressed={view === 'settings'}
              title="Settings"
              className={`rounded border px-2 py-1 text-text-primary ${
                view === 'settings'
                  ? 'border-primary/60 text-primary-bright'
                  : 'border-white/10 bg-surface-elevated/80'
              }`}
            >
              ⚙
            </button>
          )}
        </div>
      </header>

      {isSidebarVisible(view) ? (
        <div className="flex min-h-0 flex-1">
          <Sidebar view={view} onNavigate={setView} />
          <main className="min-w-0 flex-1 overflow-y-auto">
            {view === 'conversations' && <ConversationsView />}
            {view === 'activity' && <ActivityView />}
            {view === 'memory' && <MemoryView />}
            {view === 'dashboard' && <DashboardView />}
            {view === 'settings' && <SettingsView />}
          </main>
        </div>
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

      {/* KIEO-052: HITL approval overlay — full-view, above every screen. */}
      <ConfirmationOverlay />
    </div>
  )
}
