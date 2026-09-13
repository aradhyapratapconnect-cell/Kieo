// src/components/WakeWordToggle.tsx — wake-word enable + phrase edit (KIEO-032).
//
// Minimal precursor of the Settings voice section (KIEO-053 absorbs it):
// an explicit enable switch (mic is requested first — a denial leaves it
// off) and an inline phrase field that applies without restart. Prefs persist
// in localStorage until the DB-backed migration.
import { useState } from 'react'
import { MIC_DENIED_MESSAGE } from '../../shared/types'
import { useAgentStore } from '../store/useAgentStore'
import { setWakeListening } from '../voice/wakeListener'
import { getWakePhrase, setWakeEnabled, setWakePhrase } from '../voice/wakeword'

export default function WakeWordToggle(): JSX.Element {
  const wakeEnabled = useAgentStore((s) => s.wakeEnabled)
  const storeSetEnabled = useAgentStore((s) => s.setWakeEnabled)
  const setWakeNote = useAgentStore((s) => s.setWakeNote)
  const [phrase, setPhrase] = useState(getWakePhrase())
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  async function toggle(): Promise<void> {
    if (busy) return
    if (wakeEnabled) {
      setWakeListening(false)
      setWakeEnabled(false)
      storeSetEnabled(false)
      setWakeNote(null)
      return
    }
    setBusy(true)
    try {
      // Mic first: only an actually-listening toggle flips on.
      const ok = await setWakeListening(true)
      if (ok) {
        setWakeEnabled(true)
        storeSetEnabled(true)
        setWakeNote(null)
        setHint(null)
      } else {
        setWakeNote(MIC_DENIED_MESSAGE)
      }
    } finally {
      setBusy(false)
    }
  }

  function commitPhrase(value: string): void {
    if (setWakePhrase(value)) {
      setPhrase(getWakePhrase())
      setHint(null)
    } else {
      setPhrase(getWakePhrase())
      setHint('Phrase cannot be empty.')
    }
  }

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy}
          aria-pressed={wakeEnabled}
          aria-label={wakeEnabled ? 'Disable wake word' : 'Enable wake word'}
          className={`rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] disabled:opacity-50 ${
            wakeEnabled
              ? 'border-primary/60 text-primary-bright'
              : 'border-white/10 text-text-muted hover:text-text-secondary'
          }`}
        >
          {busy ? ' req…' : wakeEnabled ? '◉ wake on' : '○ wake off'}
        </button>
        <input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          onBlur={(e) => commitPhrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setPhrase(getWakePhrase())
          }}
          aria-label="Wake word phrase"
          title="Wake phrase — applies immediately, no restart"
          spellCheck={false}
          className="w-40 rounded border border-white/10 bg-surface px-2 py-0.5 font-mono text-[11px] text-text-secondary placeholder:text-text-muted focus:outline-none"
        />
      </div>
      {hint !== null && (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">{hint}</p>
      )}
    </div>
  )
}
