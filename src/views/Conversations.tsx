// src/views/Conversations.tsx — placeholder shell (full view lands in KIEO-054).
//
// Reachable via the KIEO-051 sidebar so the five-destination contract holds;
// history already persists (KIEO-040) and the list/continue UI arrives next.
export default function ConversationsView(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-2 px-4 py-6 text-left">
      <h2 className="font-display text-[20px] font-semibold leading-[28px]">Conversations</h2>
      <p className="text-[13px] text-text-secondary">
        Past conversations will list here — open one to continue chatting.
      </p>
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
        Full history browser lands in KIEO-054
      </p>
    </div>
  )
}
