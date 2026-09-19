// src/components/HomeScreen.tsx — minimalist home surface (KIEO-050).
//
// Spec §1.5: deliberately sparse — ambient particle field + radial glow +
// wordmark + tagline + floating command bar (the bar itself lives in App's
// footer). Simple Q&A answers appear in the inline response card below the
// tagline with NO view change; full history/browsing lands in KIEO-054.
import { useAgentStore } from '../store/useAgentStore'
import ParticleField from './ParticleField'

function InlineResponse(): JSX.Element | null {
  const agentState = useAgentStore((s) => s.agentState)
  const lastMessage = useAgentStore((s) => s.lastMessage)

  if (
    agentState === 'THINKING' ||
    agentState === 'EXECUTING' ||
    agentState === 'LISTENING'
  ) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="w-full max-w-xl rounded border border-white/[0.07] bg-surface/65 px-4 py-3 backdrop-blur-[16px]"
      >
        <p className="animate-pulse font-mono text-[11px] uppercase tracking-[0.06em] text-text-secondary">
          Working…
        </p>
      </div>
    )
  }

  if (agentState === 'AWAITING_APPROVAL') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="w-full max-w-xl rounded border border-caution/40 bg-surface/65 px-4 py-3 backdrop-blur-[16px]"
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          Waiting for your approval…
        </p>
      </div>
    )
  }

  if (lastMessage === null || lastMessage.text.trim().length === 0) return null

  return (
    <div
      aria-live="polite"
      role={lastMessage.isError ? 'alert' : 'status'}
      className={`w-full max-w-xl rounded border px-4 py-3 text-left backdrop-blur-[16px] ${
        lastMessage.isError
          ? 'border-danger/40 bg-surface/65'
          : 'border-white/[0.07] bg-surface/65'
      }`}
    >
      <p
        className={`max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[15px] leading-[24px] ${
          lastMessage.isError ? 'text-danger' : 'text-text-primary'
        }`}
      >
        {lastMessage.text}
      </p>
    </div>
  )
}

export default function HomeScreen(): JSX.Element {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-2 overflow-hidden px-4 text-center">
      <ParticleField />
      {/* Radial glow behind the wordmark — primary at low opacity (spec 1.5). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2"
        style={{
          background: 'radial-gradient(closest-side, rgba(6,182,212,0.12), transparent)'
        }}
      />
      <div className="relative z-10 flex w-full flex-col items-center gap-2">
        <h1 className="font-display text-[40px] font-bold leading-[48px]">Kieo</h1>
        <p className="text-[15px] text-text-secondary">
          Speak or type a command — risky actions always ask first.
        </p>
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Human-in-the-loop enabled · Local SQLite
        </p>
        <div className="mt-2 flex w-full justify-center">
          <InlineResponse />
        </div>
      </div>
    </div>
  )
}
