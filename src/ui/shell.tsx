/**
 * The editor frame.
 *
 * One rule governs the layout: every zone owns exactly one question, and is never
 * replaced by another zone's answer.
 *
 *   rail      what am I working on        (network, terrain, images, assets, ...)
 *   browser   the list for that mode
 *   canvas    the work, with its tools floating over it
 *   inspector what is selected, ABOVE map style, which is always present
 *
 * The previous layout mixed the first and third questions in the left panel, and
 * alternated between the second and third on the right -- so the map's style settings
 * disappeared the moment anything was selected, and had to be reached by deselecting.
 * Nothing had a place you could learn, which is what "hard to navigate" meant.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  IconAsset,
  IconData,
  IconImage,
  IconLayers,
  IconLine,
  IconRoute,
  IconWarn,
} from './icons'

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export type Mode = 'network' | 'terrain' | 'images' | 'assets' | 'data' | 'route' | 'checks'
export type Theme = 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

interface UiPrefs {
  theme: Theme
  density: Density
  browserWidth: number
  inspectorWidth: number
  browserOpen: boolean
  inspectorOpen: boolean
}

const PREFS_KEY = 'tds:ui'

const DEFAULT_PREFS: UiPrefs = {
  theme: 'light',
  density: 'comfortable',
  browserWidth: 284,
  inspectorWidth: 300,
  browserOpen: true,
  inspectorOpen: true,
}

function readPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UiPrefs>) }
  } catch {
    // Private windows and blocked site data both throw here. A missing preference
    // is not worth failing a launch over.
    return { ...DEFAULT_PREFS }
  }
}

/**
 * Editor preferences, persisted per browser.
 *
 * Deliberately NOT part of the project: panel widths and a dark theme belong to the
 * person sitting in front of the app, not to the map, and shipping them inside a
 * project file would impose one person's setup on everyone they send it to.
 */
export function useUiPrefs() {
  const [prefs, setPrefs] = useState<UiPrefs>(readPrefs)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* not worth surfacing */
    }
    const root = document.documentElement
    root.dataset.theme = prefs.theme
    root.dataset.density = prefs.density
  }, [prefs])

  const patch = useCallback((p: Partial<UiPrefs>) => setPrefs((cur) => ({ ...cur, ...p })), [])
  return { prefs, patch }
}

// ---------------------------------------------------------------------------
// Icon rail
// ---------------------------------------------------------------------------

export const MODES: {
  id: Mode
  label: string
  hint: string
  icon: (p: { size?: number }) => React.ReactNode
}[] = [
  { id: 'network', label: 'Network', hint: 'Lines and stops', icon: IconLine },
  { id: 'terrain', label: 'Terrain', hint: 'Rivers, parks, zones, text', icon: IconLayers },
  { id: 'images', label: 'Screenshots', hint: 'The map you are tracing', icon: IconImage },
  { id: 'assets', label: 'Assets', hint: 'Symbols, markers and furniture', icon: IconAsset },
  { id: 'route', label: 'Journeys', hint: 'Plan a trip across the network', icon: IconRoute },
  { id: 'data', label: 'Data', hint: 'Import, export and bulk edits', icon: IconData },
  { id: 'checks', label: 'Checks', hint: 'What looks wrong', icon: IconWarn },
]

export function IconRail({
  mode,
  onMode,
  issueCount,
}: {
  mode: Mode
  onMode: (m: Mode) => void
  issueCount: number
}) {
  return (
    <nav
      aria-label="Editor sections"
      className="flex shrink-0 flex-col items-center gap-1 border-r border-slate-200 bg-slate-50 py-2"
      style={{ width: 'var(--tds-rail)' }}
    >
      {MODES.map((m, i) => {
        const active = mode === m.id
        const Glyph = m.icon
        return (
          <button
            key={m.id}
            onClick={() => onMode(m.id)}
            aria-current={active ? 'page' : undefined}
            // The number is the shortcut, shown in the tooltip so it can be learned
            // without opening a reference.
            title={`${m.label} — ${m.hint}  (${i + 1})`}
            className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              active
                ? 'bg-slate-900 text-white'
                : 'text-slate-500 hover:bg-slate-200 hover:text-slate-900'
            }`}
          >
            <Glyph size={17} />
            <span className="sr-only">{m.label}</span>
            {m.id === 'checks' && issueCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-amber-500 px-1 text-[10px] font-bold leading-4 text-white">
                {issueCount > 99 ? '99+' : issueCount}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Resizable panel
// ---------------------------------------------------------------------------

/**
 * A panel you can drag wider, narrower, or shut.
 *
 * The Journeys and Screenshots panels hold two controls and one list respectively, and
 * used to occupy a fixed 290px regardless -- a third of the window given to almost
 * nothing, on a canvas that wanted every pixel.
 */
export function ResizablePanel({
  side,
  width,
  open,
  min = 200,
  max = 560,
  onWidth,
  label,
  children,
}: {
  side: 'left' | 'right'
  width: number
  open: boolean
  min?: number
  max?: number
  onWidth: (w: number) => void
  label: string
  children: React.ReactNode
}) {
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(width)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const delta = side === 'left' ? e.clientX - startX.current : startX.current - e.clientX
      onWidth(Math.max(min, Math.min(max, startW.current + delta)))
    }
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, side, min, max, onWidth])

  if (!open) return null

  const grip = (
    <div
      className="tds-resizer"
      data-dragging={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      tabIndex={0}
      onPointerDown={(e) => {
        startX.current = e.clientX
        startW.current = width
        setDragging(true)
      }}
      // Keyboard resizing, because a pointer-only control is unusable for anyone
      // who does not use one.
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12
        if (e.key === 'ArrowLeft') onWidth(Math.max(min, Math.min(max, width + (side === 'left' ? -step : step))))
        if (e.key === 'ArrowRight') onWidth(Math.max(min, Math.min(max, width + (side === 'left' ? step : -step))))
      }}
    />
  )

  return (
    <>
      {side === 'right' && grip}
      <aside
        aria-label={label}
        className="tds-scroll flex shrink-0 flex-col overflow-y-auto bg-white"
        style={{ width }}
      >
        {children}
      </aside>
      {side === 'left' && grip}
    </>
  )
}

// ---------------------------------------------------------------------------
// Floating tools
// ---------------------------------------------------------------------------

/**
 * The tool palette, floating over the canvas.
 *
 * It used to be a labelled horizontal row inside the top bar, eating 64px of height
 * across the full width. Vertical and floating costs nothing but a sliver of canvas,
 * and -- the reason it had to move -- it SCALES: placing assets, drawing zones and
 * marking pass-through stops are three more tools that a labelled horizontal row
 * could not have absorbed.
 */
export function FloatingTools({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1">
      <div className="pointer-events-auto flex flex-col gap-0.5 rounded-2xl border border-slate-200 bg-white/95 p-1 shadow-lg backdrop-blur">
        {children}
      </div>
    </div>
  )
}

/** One tool. Icon only, with its name and shortcut in the tooltip. */
export function ToolTile({
  active,
  label,
  shortcut,
  onClick,
  children,
}: {
  active: boolean
  label: string
  shortcut?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={shortcut ? `${label}  (${shortcut})` : label}
      className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Overflow menu
// ---------------------------------------------------------------------------

/**
 * Whatever the top bar cannot fit.
 *
 * The bar previously clipped instead of collapsing, and Export -- the one action that
 * gets your work out of the app -- fell off it below about 1100px wide. Anything
 * optional now lives here; Export never does.
 */
export function OverflowMenu({
  label,
  children,
}: {
  label: string
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
      >
        <IconMoreGlyph />
        <span className="sr-only">{label}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function IconMoreGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </svg>
  )
}

/** A row in the overflow menu. */
export function MenuItem({
  onClick,
  children,
  hint,
}: {
  onClick: () => void
  children: React.ReactNode
  hint?: string
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-100 hover:text-slate-900"
    >
      <span>{children}</span>
      {hint && <span className="shrink-0 font-mono text-[10px] text-slate-400">{hint}</span>}
    </button>
  )
}

/** A panel heading with an optional action on the right. */
export function PanelHeader({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
      <h2 className="text-[13px] font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  )
}
