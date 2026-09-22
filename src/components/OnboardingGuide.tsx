// src/components/OnboardingGuide.tsx — first-run walkthrough (KIEO-064).
//
// Centered modal (z-40, below the z-50 HITL card so approvals always win).
// Dismissal persists via the caller's onClose; the guide never writes
// settings itself. Keyboard: →/Enter advances, ← goes back, Esc dismisses.
import { useEffect, useState } from 'react'
import { ONBOARDING_STEPS } from './onboardingSteps'

export default function OnboardingGuide({ onClose }: { onClose: () => void }): JSX.Element {
  const [index, setIndex] = useState(0)
  const step = ONBOARDING_STEPS[index]
  const last = index === ONBOARDING_STEPS.length - 1

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        setIndex((i) => (i >= ONBOARDING_STEPS.length - 1 ? i : i + 1))
      } else if (e.key === 'ArrowLeft') {
        setIndex((i) => (i <= 0 ? i : i - 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="flex max-h-[85vh] w-full max-w-xl flex-col gap-4 overflow-hidden rounded-lg border border-white/[0.12] bg-surface/95 p-5 backdrop-blur-[24px]"
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
            How to use Kieo · {index + 1}/{ONBOARDING_STEPS.length}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted hover:text-text-primary"
          >
            Skip
          </button>
        </div>

        <h2 id="onboarding-title" className="font-display text-[20px] font-semibold leading-[28px]">
          {step.title}
        </h2>
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          {step.body.map((para, i) => (
            <p key={i} className="text-[15px] leading-[24px] text-text-secondary">
              {para}
            </p>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-hidden="true">
            {ONBOARDING_STEPS.map((s, i) => (
              <span
                key={s.title}
                className={`inline-block h-1.5 w-6 rounded-full ${
                  i === index ? 'bg-primary' : 'bg-white/10'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex((i) => i - 1)}
                className="rounded border border-white/10 bg-surface-elevated/80 px-3 py-1 text-[14px] text-text-primary"
              >
                Back
              </button>
            )}
            {last ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-primary px-4 py-1 text-[14px] font-semibold text-bg-base"
              >
                Get started
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIndex((i) => i + 1)}
                className="rounded bg-primary px-4 py-1 text-[14px] font-semibold text-bg-base"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
