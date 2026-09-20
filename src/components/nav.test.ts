// src/components/nav.test.ts — KIEO-051 navigation contract coverage.
import { describe, expect, it } from 'vitest'
import { DESTINATION_ITEMS, NAV_ITEMS, isSidebarVisible, isViewId } from './nav'

describe('KIEO-051 navigation registry', () => {
  it('exposes all five ticket destinations plus Home', () => {
    const ids = NAV_ITEMS.map((item) => item.id)
    expect(ids).toEqual([
      'home',
      'conversations',
      'activity',
      'memory',
      'dashboard',
      'settings'
    ])
    expect(DESTINATION_ITEMS.map((item) => item.id)).toEqual([
      'conversations',
      'activity',
      'memory',
      'dashboard',
      'settings'
    ])
  })

  it('ids are unique and every item has a label + monogram', () => {
    const ids = NAV_ITEMS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0)
      expect(item.monogram.trim().length).toBe(1)
    }
  })

  it('sidebar shows on every view except the distraction-free home', () => {
    expect(isSidebarVisible('home')).toBe(false)
    for (const item of DESTINATION_ITEMS) {
      expect(isSidebarVisible(item.id)).toBe(true)
    }
  })

  it('guards unknown view ids', () => {
    expect(isViewId('memory')).toBe(true)
    expect(isViewId('home')).toBe(true)
    expect(isViewId('nowhere')).toBe(false)
    expect(isViewId(null)).toBe(false)
  })
})
