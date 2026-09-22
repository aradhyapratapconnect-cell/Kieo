// src/components/onboardingSteps.ts — guide content (KIEO-064).
//
// Pure data (no JSX) so the walkthrough contract is unit-tested: one step
// per core concept — command bar, wake word, permission model — each with a
// title and two short paragraphs. The modal in OnboardingGuide.tsx renders
// this verbatim.
export interface OnboardingStep {
  title: string
  body: string[]
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: 'Ask with text or voice',
    body: [
      'Type into the command bar — or tap the mic and speak. Drop files onto the bar to attach them as context.',
      'Short answers appear right under the wordmark; longer sessions live under Conversations in the sidebar.'
    ]
  },
  {
    title: 'Wake word, only when you want it',
    body: [
      'Flip the wake toggle and say “Hey Kieo” followed by your command. The mic is requested first — a denial leaves voice off.',
      'You can rename the phrase in Settings; it applies immediately, no restart.'
    ]
  },
  {
    title: 'Risky actions always ask first',
    body: [
      'Reads run instantly, but anything mutating pauses on a confirmation card showing the exact action. Approve with the button, Enter/Y, or by saying “yes”.',
      'Settings → Permissions tunes each action type: Always Allow, Ask Every Time, or Never Allow — effective on the very next action.'
    ]
  },
  {
    title: 'Memory, activity, and keys',
    body: [
      'Durable facts you state (“I use pnpm”) are remembered and listed under Memory, where you can edit or delete them.',
      'Every action lands in Activity with its approval trail. Bring any provider key under Settings → AI Providers — keys stay encrypted in the OS keychain.'
    ]
  }
]
