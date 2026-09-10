// src/App.tsx — KIEO-001 scaffold shell.
// Proves: window launches, Tailwind + design tokens apply, Zustand store works.
// Full HomeScreen/CommandBar/views land in KIEO-050+ (Epic F).
import { useAgentStore } from './store/useAgentStore'

export default function App(): JSX.Element {
  const agentState = useAgentStore((s) => s.agentState)

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
        </div>
        <button
          type="button"
          aria-label="Settings"
          className="rounded border border-white/10 bg-surface-elevated/80 px-2 py-1 text-text-primary"
        >
          ⚙
        </button>
      </header>

      {/* Center wordmark — emptiness is intentional (spec 1.5). */}
      <main className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <h1 className="font-display text-[40px] font-bold leading-[48px]">Kieo</h1>
        <p className="text-[15px] text-text-secondary">
          Scaffold online — Tailwind + tokens + Zustand store wired.
        </p>
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Human-in-the-loop enabled · Local SQLite
        </p>
      </main>

      {/* Floating command bar placeholder (real one: KIEO-050 + KIEO-030). */}
      <footer className="flex justify-center px-4 pb-8">
        <div className="flex w-full max-w-xl items-center gap-2 rounded border border-white/[0.12] bg-bg-base px-3 py-2">
          <span className="text-text-muted">＋</span>
          <input
            className="flex-1 bg-transparent text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none"
            placeholder="Ask Kieo anything… (command bar lands in KIEO-050)"
            disabled
          />
          <span className="text-text-muted">🎙</span>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base"
          >
            Send
          </button>
        </div>
      </footer>
    </div>
  )
}
