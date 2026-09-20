// src/components/Sidebar.tsx — persistent left navigation (KIEO-051).
//
// Shown on every view except the distraction-free home screen (see
// isSidebarVisible). Active destination uses the primary token
// (--color-primary; the ticket's --color-accent predates the v4 palette
// rename) as a left indicator bar + bright label, so the current view is
// always visually indicated.
import { NAV_ITEMS, type ViewId } from './nav'

export default function Sidebar({
  view,
  onNavigate
}: {
  view: ViewId
  onNavigate: (view: ViewId) => void
}): JSX.Element {
  return (
    <aside
      aria-label="Primary"
      className="flex h-full w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-white/[0.08] bg-surface px-2 py-4"
    >
      <p className="px-2 pb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-text-muted">
        Kieo
      </p>
      <nav className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = view === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded border-l-2 px-2 py-1.5 text-left text-[14px] ${
                active
                  ? 'border-primary bg-white/[0.04] font-semibold text-primary-bright'
                  : 'border-transparent text-text-secondary hover:bg-white/[0.02] hover:text-text-primary'
              }`}
            >
              <span
                aria-hidden="true"
                className={`grid h-5 w-5 shrink-0 place-items-center rounded border font-mono text-[11px] ${
                  active
                    ? 'border-primary/60 bg-primary/10 text-primary-bright'
                    : 'border-white/10 text-text-muted'
                }`}
              >
                {item.monogram}
              </span>
              {item.label}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
