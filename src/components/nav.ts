// src/components/nav.ts — view registry + sidebar visibility (KIEO-051).
//
// Single source of truth for every navigable destination: the five ticket
// views (Conversations / Activity / Memory / Dashboard / Settings) plus
// Home. Both the home top-bar quick links and the persistent sidebar render
// from NAV_ITEMS, so a destination can never exist in one and be missing
// from the other. DOM-free — unit-tested headlessly.
export type ViewId =
  | 'home'
  | 'conversations'
  | 'activity'
  | 'memory'
  | 'dashboard'
  | 'settings'

export interface NavItem {
  id: ViewId
  label: string
  /** Single-letter badge (no icon font dependency). */
  monogram: string
}

/** The five ticket destinations, in ticket order. */
export const DESTINATION_ITEMS: NavItem[] = [
  { id: 'conversations', label: 'Conversations', monogram: 'C' },
  { id: 'activity', label: 'Activity', monogram: 'A' },
  { id: 'memory', label: 'Memory', monogram: 'M' },
  { id: 'dashboard', label: 'Dashboard', monogram: 'D' },
  { id: 'settings', label: 'Settings', monogram: 'S' }
]

/** Every reachable view, Home first (sidebar + home top bar share this). */
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', monogram: 'H' },
  ...DESTINATION_ITEMS
]

/**
 * Sidebar visibility per the Frontend Spec + ticket AC: every view keeps
 * the persistent left sidebar EXCEPT the distraction-free home screen,
 * which stays chrome-light (status + quick links only).
 */
export function isSidebarVisible(view: ViewId): boolean {
  return view !== 'home'
}

export function isViewId(value: unknown): value is ViewId {
  return (
    typeof value === 'string' &&
    (NAV_ITEMS as Array<{ id: string }>).some((item) => item.id === value)
  )
}
