// src/components/VoiceProfileSetup.tsx — owner voice enrollment (KIEO-062).
//
// Settings wizard: captures ~5 utterances (reusing the VAD-bounded approval
// capture — 16kHz PCM, no new audio plumbing), shows consistency across
// samples, and commits an averaged on-device profile. Raw audio is never
// stored; only the averaged embedding persists locally. Without provisioned
// model weights every step fails typed and the UI says so plainly —
// verification stays fail-closed, never pretend-matched.
import { useCallback, useEffect, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore'
import { captureApprovalUtterance } from '../voice/approvalChannel'

interface ProfileStatus {
  enrolled: boolean
  samples: number
  threshold: number
  ownerOnly: boolean
  targetSamples: number
}

const MIN_COMMIT = 3

export default function VoiceProfileSetup(): JSX.Element {
  const setWakeNote = useAgentStore((s) => s.setWakeNote)
  const [status, setStatus] = useState<ProfileStatus | null>(null)
  const [captured, setCaptured] = useState(0)
  const [consistency, setConsistency] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.kieo : undefined
    if (!api) {
      setError('Voice profile unavailable outside the desktop app.')
      return
    }
    api
      .getVoiceProfileStatus()
      .then((s) => setStatus(s))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function toggleOwnerOnly(enabled: boolean): Promise<void> {
    setBusy('owner')
    setError(null)
    try {
      const res = await window.kieo.setVoiceOwnerOnly(enabled)
      if (!res.ok) {
        setError(res.error ?? 'Could not save that setting — try again.')
        return
      }
      setStatus((prev) => (prev ? { ...prev, ownerOnly: res.ownerOnly ?? enabled } : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function recordSample(): Promise<void> {
    setBusy('capture')
    setError(null)
    try {
      setWakeNote('Speak a short phrase…')
      const clip = await captureApprovalUtterance()
      if (!clip) {
        setError('Microphone unavailable — check the OS microphone permission.')
        return
      }
      const res = await window.kieo.voiceEnrollAdd(clip.pcm, clip.sampleRate)
      if (!res.ok) {
        setError(res.message)
        return
      }
      setCaptured(res.samples)
      setConsistency(res.consistency)
      setNotice(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWakeNote(null)
      setBusy(null)
    }
  }

  async function commit(): Promise<void> {
    setBusy('commit')
    setError(null)
    try {
      const res = await window.kieo.voiceEnrollCommit()
      if (!res.ok) {
        setError(res.message ?? res.error ?? 'Could not save the profile — try again.')
        return
      }
      setCaptured(0)
      setConsistency(null)
      setNotice(`Owner voice enrolled from ${res.samples} samples — stored only on this machine.`)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function reset(): Promise<void> {
    setBusy('reset')
    try {
      await window.kieo.voiceEnrollReset()
      setCaptured(0)
      setConsistency(null)
      setNotice(null)
    } finally {
      setBusy(null)
    }
  }

  const target = status?.targetSamples ?? 5

  return (
    <div className="flex flex-col gap-2 rounded border border-white/[0.07] bg-surface/65 px-3 py-2 backdrop-blur-[16px]">
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
        Owner voice
      </p>
      <p className="text-[13px] text-text-secondary">
        {status?.enrolled
          ? `Enrolled from ${status.samples} samples. Spoken approvals ${status.ownerOnly ? 'require your voice' : 'accept any voice'}.`
          : 'Not enrolled. Enroll to optionally restrict spoken approvals to your voice.'}
      </p>

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={status?.ownerOnly ?? false}
          disabled={busy !== null || !status?.enrolled}
          onChange={(e) => void toggleOwnerOnly(e.target.checked)}
          title={status?.enrolled ? undefined : 'Enroll first'}
          className="h-4 w-4 accent-[#06B6D4] disabled:opacity-50"
        />
        <span className="text-[14px] text-text-primary">Spoken approvals require my voice</span>
      </label>
      {!status?.enrolled && (
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Enroll below to enable this
        </p>
      )}

      <div className="flex flex-col gap-2 rounded border border-white/[0.07] bg-bg-base px-2 py-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
          Enrollment · {captured}/{target} samples
          {consistency !== null && ` · consistency ${Math.round(consistency * 100)}%`}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void recordSample()}
            disabled={busy !== null}
            className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-primary disabled:opacity-50"
          >
            {busy === 'capture' ? 'Listening…' : 'Record sample'}
          </button>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy !== null || captured < MIN_COMMIT}
            title={captured < MIN_COMMIT ? `Need at least ${MIN_COMMIT} samples` : undefined}
            className="rounded bg-primary px-3 py-1 text-[14px] font-semibold text-bg-base disabled:opacity-50"
          >
            Save profile
          </button>
          {(captured > 0 || busy !== null) && (
            <button
              type="button"
              onClick={() => void reset()}
              disabled={busy !== null}
              className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              Discard
            </button>
          )}
        </div>
        {consistency !== null && consistency < 0.7 && (
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
            Low consistency — try re-recording in a quieter spot
          </p>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="font-mono text-[11px] uppercase tracking-[0.06em] text-caution">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="font-mono text-[11px] uppercase tracking-[0.06em] text-safe">
          {notice}
        </p>
      )}
    </div>
  )
}
