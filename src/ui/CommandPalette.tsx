import { useEffect, useMemo, useRef, useState } from 'react'

import { networkOf, useEditor } from '../store/editor-store'
import { requestFit } from '../render/MapView'

interface Entry {
  id: string
  label: string
  hint: string
  group: 'Station' | 'Line' | 'Go' | 'Do' | 'History'
  run: () => void
  color?: string
}

/** How long ago, in the roughest terms that are still useful. */
function ago(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  return `${Math.round(mins / 60)} h ago`
}

/**
 * Subsequence match with a light score: earlier matches and word-boundary hits rank
 * higher, so typing "cs" finds "Central Station" before "Docks South".
 */
function score(text: string, query: string): number | null {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (t.startsWith(q)) return 1000
  let ti = 0
  let points = 0
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti)
    if (found < 0) return null
    if (found === 0 || t[found - 1] === ' ') points += 8
    points += Math.max(0, 6 - (found - ti))
    ti = found + 1
  }
  return points
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const project = useEditor((s) => s.project)
  const select = useEditor((s) => s.select)
  const setTool = useEditor((s) => s.setTool)
  const setSpace = useEditor((s) => s.setSpace)
  const setView = useEditor((s) => s.setView)
  const setActiveLine = useEditor((s) => s.setActiveLine)
  const straightenLine = useEditor((s) => s.straightenLine)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const travel = useEditor((s) => s.travel)
  const timeline = useEditor((s) => s.timeline)

  useEffect(() => inputRef.current?.focus(), [])

  const entries = useMemo<Entry[]>(() => {
    if (!project) return []
    const network = networkOf(project)
    const out: Entry[] = []

    for (const s of project.stations) {
      const serving = network.linesAtStation.get(s.id)?.length ?? 0
      out.push({
        id: `st-${s.id}`,
        label: s.name || 'Unnamed station',
        hint: serving === 0 ? 'on no line' : `${serving} line${serving === 1 ? '' : 's'}`,
        group: 'Station',
        run: () => {
          select({ stations: [s.id] })
          requestFit('selection')
        },
      })
    }

    for (const l of project.lines) {
      const stops = l.branches.reduce((n, b) => n + b.stops.length, 0)
      out.push({
        id: `ln-${l.id}`,
        label: l.name || 'Untitled line',
        hint: `${l.mode} · ${stops} stops`,
        group: 'Line',
        color: l.color,
        run: () => {
          select({ lines: [l.id] })
          setActiveLine(l.id, l.branches[0]?.id ?? null)
        },
      })
      out.push({
        id: `straighten-${l.id}`,
        label: `Straighten ${l.name || 'line'}`,
        hint: 'octilinearise this line only',
        group: 'Do',
        run: () => straightenLine(l.id),
      })
    }

    out.push(
      { id: 'go-geo', label: 'Geographic view', hint: 'G', group: 'Go', run: () => setSpace('geo') },
      { id: 'go-sch', label: 'Schematic view', hint: 'G', group: 'Go', run: () => setSpace('schematic') },
      { id: 'fit', label: 'Zoom to fit', hint: 'F', group: 'Go', run: () => requestFit('all') },
      { id: 't-select', label: 'Select tool', hint: 'V', group: 'Do', run: () => setTool('select') },
      { id: 't-station', label: 'Station tool', hint: 'S', group: 'Do', run: () => setTool('station') },
      { id: 't-line', label: 'Line tool', hint: 'L', group: 'Do', run: () => setTool('line') },
      { id: 't-terrain', label: 'Terrain tool', hint: 'T', group: 'Do', run: () => setTool('terrain') },
      { id: 't-bend', label: 'Bend tool', hint: 'B', group: 'Do', run: () => setTool('bend') },
      { id: 'undo', label: 'Undo', hint: 'Ctrl+Z', group: 'Do', run: undo },
      { id: 'redo', label: 'Redo', hint: 'Ctrl+Shift+Z', group: 'Do', run: redo },
      {
        id: 'toggle-ghosts',
        label: `${project.view.showGeoGhosts ? 'Hide' : 'Show'} true-position ghosts`,
        hint: 'compare diagram against reality',
        group: 'Do',
        run: () => setView({ showGeoGhosts: !project.view.showGeoGhosts }),
      },
      {
        id: 'toggle-labels',
        label: `${project.view.showLabels ? 'Hide' : 'Show'} labels`,
        hint: '',
        group: 'Do',
        run: () => setView({ showLabels: !project.view.showLabels }),
      },
      {
        id: 'toggle-auto',
        label: `${project.view.autoLabels ? 'Stop' : 'Start'} auto-placing labels`,
        hint: 'pinned labels are never touched',
        group: 'Do',
        run: () => setView({ autoLabels: !project.view.autoLabels }),
      },
    )

    // The history, as somewhere you can go rather than a door you step through one move
    // at a time. It lives here rather than in a panel because it is the thing you want
    // twice a week and never want taking up room: after twenty small nudges, "put it
    // back to before I started moving things" is twenty keystrokes and a guess about
    // when to stop.
    const line = timeline()
    line.past
      .slice()
      .reverse()
      .slice(0, 20)
      .forEach((entry, i) => {
        out.push({
          id: `hist-back-${i}`,
          label: `Undo back to before “${entry.label}”`,
          hint: `${i + 1} step${i === 0 ? '' : 's'} back · ${ago(entry.at)}`,
          group: 'History',
          run: () => travel(-(i + 1)),
        })
      })
    line.future.slice(0, 20).forEach((entry, i) => {
      out.push({
        id: `hist-fwd-${i}`,
        label: `Redo forward through “${entry.label}”`,
        hint: `${i + 1} step${i === 0 ? '' : 's'} forward`,
        group: 'History',
        run: () => travel(i + 1),
      })
    })

    return out
  }, [
    project,
    select,
    setTool,
    setSpace,
    setView,
    setActiveLine,
    straightenLine,
    undo,
    redo,
    travel,
    timeline,
  ])

  const results = useMemo(() => {
    const scored = entries
      .map((e) => ({ e, s: score(`${e.label} ${e.hint}`, query) }))
      .filter((r): r is { e: Entry; s: number } => r.s !== null)
      .sort((a, b) => b.s - a.s)
    return scored.slice(0, 60).map((r) => r.e)
  }, [entries, query])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const commit = (entry?: Entry) => {
    const target = entry ?? results[active]
    if (!target) return
    target.run()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(results.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
          placeholder="Jump to a station or line, or run a command…"
          className="w-full border-b border-slate-200 px-4 py-3 text-sm focus:outline-none"
        />
        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-400">Nothing matches that.</p>
        ) : (
          <ul ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {results.map((e, i) => (
              <li key={e.id}>
                <button
                  data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(e)}
                  className={`flex w-full items-center gap-2.5 px-4 py-2 text-left ${
                    i === active ? 'bg-slate-100' : ''
                  }`}
                >
                  {e.color ? (
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: e.color }}
                    />
                  ) : (
                    <span className="w-2.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{e.label}</span>
                  {e.hint && (
                    <span className="shrink-0 font-mono text-[10px] text-slate-400">{e.hint}</span>
                  )}
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                    {e.group}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-slate-200 px-4 py-2 font-mono text-[10px] text-slate-400">
          ↑↓ move · ↵ run · esc close
        </p>
      </div>
    </div>
  )
}
