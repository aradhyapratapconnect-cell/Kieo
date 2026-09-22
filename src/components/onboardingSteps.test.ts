// src/components/onboardingSteps.test.ts — KIEO-064 content contract.
import { describe, expect, it } from 'vitest'
import { ONBOARDING_STEPS } from './onboardingSteps'

describe('KIEO-064 onboarding content', () => {
  it('covers command bar, wake word, and the permission model', () => {
    const text = ONBOARDING_STEPS.map((s) => `${s.title} ${s.body.join(' ')}`.toLowerCase()).join(
      '\n'
    )
    expect(text).toMatch(/command bar/)
    expect(text).toMatch(/wake/)
    expect(text).toMatch(/permission|approval|confirm/)
  })

  it('every step is complete and renderable', () => {
    expect(ONBOARDING_STEPS.length).toBeGreaterThanOrEqual(3)
    for (const step of ONBOARDING_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0)
      expect(step.body.length).toBeGreaterThanOrEqual(1)
      for (const para of step.body) expect(para.trim().length).toBeGreaterThan(0)
    }
    const titles = ONBOARDING_STEPS.map((s) => s.title)
    expect(new Set(titles).size).toBe(titles.length)
  })
})
