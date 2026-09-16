/**
 * First-run guidance.
 *
 * The editor used to open on a blank canvas surrounded by every control at once, which
 * reads as "complex and impossible" before you have done anything. Two things fix that:
 * an empty canvas that offers three concrete ways to begin, and a coach that names the
 * single next useful action and then gets out of the way.
 *
 * Nothing here blocks the canvas or forces an order. It is a suggestion, dismissible
 * forever, and re-openable from the help menu.
 */

import { useEffect, useState } from 'react'

import { useEditor } from '../store/editor-store'
import { Button, IconButton, Kbd } from './primitives'
import {
  IconClose,
  IconDiagram,
  IconImage,
  IconLine,
  IconStation,
} from './icons'

const DISMISS_KEY = 'tds:coach-dismissed'

export const coachDismissed = () => localStorage.getItem(DISMISS_KEY) === '1'
export const dismissCoach = () => localStorage.setItem(DISMISS_KEY, '1')
export const restoreCoach = () => localStorage.removeItem(DISMISS_KEY)

// ---------------------------------------------------------------------------
// Stage detection
// ---------------------------------------------------------------------------

type Stage =
  | 'empty'
  | 'images-placed'
  | 'stations-placed'
  | 'line-started'
  | 'ready-to-compose'
  | 'composing'
  | 'done'

interface Step {
  title: string
  body: React.ReactNode
  icon: React.ReactNode
}

const STEPS: Record<Exclude<Stage, 'empty' | 'done'>, Step> = {
  'images-placed': {
    icon: <IconImage size={15} />,
    title: 'Arrange your screenshots',
    body: (
      <>
        Drag each one into place — edges snap to their neighbours. When the map lines up,
        press <Kbd>S</Kbd> and click to drop your first station.
      </>
    ),
  },
  'stations-placed': {
    icon: <IconLine size={15} />,
    title: 'Now connect them into a line',
    body: (
      <>
        Hit <strong>New line</strong> on the left, then click its stations in order. The
        app draws the track and works out the interchanges for you.
      </>
    ),
  },
  'line-started': {
    icon: <IconLine size={15} />,
    title: 'Keep clicking stations',
    body: (
      <>
        Each click adds the next stop. Press <Kbd>Esc</Kbd> when the route is finished, or
        start a second line that reuses some of the same stations.
      </>
    ),
  },
  'ready-to-compose': {
    icon: <IconDiagram size={15} />,
    title: 'Switch to the diagram',
    body: (
      <>
        Press <Kbd>G</Kbd>. Your stations appear at their real positions — now drag them
        into a clean shape.
      </>
    ),
  },
  composing: {
    icon: <IconDiagram size={15} />,
    title: 'Drag a station',
    body: (
      <>
        Aim roughly at a 45° angle from a station it connects to and it will snap exactly
        onto the guide. Hold <Kbd>Alt</Kbd> to place it anywhere instead.
      </>
    ),
  },
}

function detectStage(): Stage {
  const s = useEditor.getState()
  const p = s.project
  if (!p) return 'empty'
  if (p.stations.length === 0 && p.images.length === 0) return 'empty'
  if (p.stations.length === 0) return 'images-placed'

  const stops = p.lines.reduce(
    (n, l) => n + l.branches.reduce((m, b) => m + b.stops.length, 0),
    0,
  )
  if (p.lines.length === 0) return 'stations-placed'
  if (stops < 2) return 'line-started'
  if (s.space === 'geo') return 'ready-to-compose'

  // In the diagram with everything still at its geographic position: nothing moved yet.
  const moved = p.stations.some(
    (st) => Math.abs(st.schematic.x - st.geo.x) > 1 || Math.abs(st.schematic.y - st.geo.y) > 1,
  )
  return moved ? 'done' : 'composing'
}

// ---------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------

export function Coach({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const project = useEditor((s) => s.project)
  const space = useEditor((s) => s.space)
  const [stage, setStage] = useState<Stage>('empty')

  useEffect(() => setStage(detectStage()), [project, space])

  if (!visible || stage === 'empty' || stage === 'done') return null
  const step = STEPS[stage]

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-20 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
          {step.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-slate-900">{step.title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-slate-600">{step.body}</p>
        </div>
        <IconButton label="Stop showing tips" size="sm" onClick={onDismiss}>
          <IconClose size={14} />
        </IconButton>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty canvas
// ---------------------------------------------------------------------------

export function CanvasEmptyState({ onImport }: { onImport: () => void }) {
  const project = useEditor((s) => s.project)
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)

  if (!project || project.stations.length > 0 || project.images.length > 0) return null
  // Once a drawing tool is picked the card has done its job, and it sits over exactly
  // the part of the canvas you are about to click. Get out of the way.
  if (tool !== 'select' && tool !== 'pan') return null

  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white/95 p-6 shadow-xl backdrop-blur">
        <h2 className="text-base font-semibold text-slate-900">Two ways to begin</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
          Most people trace over screenshots of their game map. You can also skip that and
          draw the network straight onto the blank canvas.
        </p>

        <div className="mt-5 space-y-2">
          <button
            onClick={onImport}
            className="flex w-full items-start gap-3 rounded-xl border border-slate-200 p-3 text-left transition-colors hover:border-slate-900 hover:bg-slate-50"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
              <IconImage size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-slate-900">
                Import map screenshots
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-slate-500">
                Drop in overlapping captures, drag them together, then trace on top.
              </span>
            </span>
          </button>

          <button
            onClick={() => setTool('station')}
            className="flex w-full items-start gap-3 rounded-xl border border-slate-200 p-3 text-left transition-colors hover:border-slate-900 hover:bg-slate-50"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
              <IconStation size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-slate-900">
                Start placing stations
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-slate-500">
                Click anywhere to drop a stop. Connect them into lines afterwards.
              </span>
            </span>
          </button>
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          Nothing here is permanent — <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> undoes anything, and
          your work saves itself as you go.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Tools',
    rows: [
      ['V', 'Select and move'],
      ['S', 'Place stations'],
      ['L', 'Build a line'],
      ['T', 'Trace terrain'],
      ['B', 'Bend a segment'],
      ['H', 'Pan the canvas'],
    ],
  },
  {
    title: 'Sections',
    rows: [
      ['1 – 7', 'Network · Terrain · Screenshots · Assets · Journeys · Data · Checks'],
    ],
  },
  {
    title: 'Moving around',
    rows: [
      ['G', 'Swap geographic ↔ diagram'],
      ['F', 'Zoom to fit, or to selection'],
      ['Scroll', 'Zoom at the cursor'],
      ['Middle-drag', 'Pan from any tool'],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['Alt (hold)', 'Suspend snapping mid-drag'],
      ['Shift+click', 'Add to the selection'],
      ['Drag on empty', 'Box-select stations'],
      ['Arrows', 'Nudge 1px · Shift for 10px'],
      ['Delete / Backspace', 'Remove the selection, whatever it is'],
      ['Esc', 'Cancel the trace, then the selection'],
    ],
  },
  {
    title: 'Reshaping',
    rows: [
      ['Click an edge', 'Add a corner to a selected river or park'],
      ['Alt (hold)', 'Trace or reshape without snapping'],
      ['Drag a handle', 'Move that corner'],
      ['Alt+click a handle', 'Remove it'],
      ['Drag the shape', 'Move the whole thing'],
    ],
  },
  {
    title: 'Everything else',
    rows: [
      ['Ctrl+K', 'Search stations, lines and commands'],
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Shift+Z', 'Redo (Ctrl+Y too)'],
      ['?', 'This list'],
    ],
  },
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Keyboard shortcuts</h2>
            <p className="mt-0.5 text-[13px] text-slate-500">
              With the bend tool, Alt+click a segment inserts a station and Alt+click a
              handle removes it.
            </p>
          </div>
          <IconButton label="Close" onClick={onClose}>
            <IconClose size={15} />
          </IconButton>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <p className="mb-2 text-[12px] font-semibold text-slate-600">{g.title}</p>
              <dl className="space-y-1.5">
                {g.rows.map(([key, what]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4">
                    <dd className="min-w-0 flex-1 truncate text-[12.5px] text-slate-700">
                      {what}
                    </dd>
                    <dt className="shrink-0">
                      <Kbd>{key}</Kbd>
                    </dt>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>

        <div className="mt-6 flex justify-end border-t border-slate-200 pt-4">
          <Button variant="primary" size="md" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  )
}
