// src/views/Settings.tsx — placeholder shell (full view lands in KIEO-053).
//
// Reachable via the KIEO-051 sidebar and the header gear so the
// five-destination contract holds; permissions/providers/keys UI arrives next.
export default function SettingsView(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-2 px-4 py-6 text-left">
      <h2 className="font-display text-[20px] font-semibold leading-[28px]">Settings</h2>
      <p className="text-[13px] text-text-secondary">
        Permissions, AI providers, API keys, and voice preferences will live here.
      </p>
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
        Full settings land in KIEO-053
      </p>
    </div>
  )
}
