// electron/tray.ts — System tray + global hotkey registration (KIEO-001 stub).
// Full tray menu / wake-word hotkey wiring lands with voice tickets (KIEO-032).
import type { BrowserWindow } from 'electron'

export function registerTray(win: BrowserWindow): void {
  // TODO(KIEO-032): create Tray icon, show/hide window on click, register
  // global hotkey for push-to-talk. Intentionally a no-op in KIEO-001 so the
  // scaffold launches cleanly on all three OS targets.
  void win
}
