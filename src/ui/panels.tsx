import { useMemo, useState } from 'react'

import { applyCsv, linesToCsv, parseCsv, stationsToCsv, type ImportReport } from '../domain/csv'
import { LINE_PALETTE, STYLE_PRESETS, modeById } from '../domain/defaults'
import { splitSegmentKey, type Space } from '../domain/network'
import type {
  ImageLayer,
  Line,
  LineId,
  SnapKind,
  StationId,
  TerrainKind,
} from '../domain/types'
import { summarizeIssues, validateProject } from '../domain/validate'
import { downloadText, importImageFiles, pickFiles } from '../persistence/files'
import { requestFit } from '../render/MapView'
import { networkOf, useEditor, type Tool } from '../store/editor-store'
import {
  IconBend,
  IconBranch,
  IconCheck,
  IconCursor,
  IconData,
  IconDiagram,
  IconExport,
  IconEye,
  IconEyeOff,
  IconFit,
  IconGlobe,
  IconHand,
  IconHelp,
  IconLayers,
  IconLine,
  IconMagnet,
  IconPlus,
  IconRedo,
  IconStation,
  IconStraighten,
  IconTerrain,
  IconTrash,
  IconUndo,
  IconWarn,
} from './icons'
import {
  Button,
  Divider,
  EmptyState,
  Field,
  IconButton,
  Kbd,
  Popover,
  Section,
  SectionLabel,
  Segmented,
  Slider,
  Toggle,
  ToolButton,
  inputClass,
} from './primitives'

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const TOOLS: { id: Tool; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'select', label: 'Select', hint: 'Select and move things (V)', icon: <IconCursor size={17} /> },
  { id: 'station', label: 'Station', hint: 'Click the map to drop a station (S)', icon: <IconStation size={17} /> },
  { id: 'line', label: 'Line', hint: 'Click stations in order to build a route (L)', icon: <IconLine size={17} /> },
  { id: 'terrain', label: 'Terrain', hint: 'Trace a river, coast or park (T)', icon: <IconTerrain size={17} /> },
  { id: 'bend', label: 'Bend', hint: 'Click a segment to add a corner (B)', icon: <IconBend size={17} /> },
  { id: 'pan', label: 'Pan', hint: 'Drag to pan (H)', icon: <IconHand size={17} /> },
]

const TERRAIN_KINDS: { id: TerrainKind; label: string }[] = [
  { id: 'waterway', label: 'River' },
  { id: 'water', label: 'Lake or sea' },
  { id: 'green', label: 'Park' },
  { id: 'builtup', label: 'Built-up' },
  { id: 'boundary', label: 'Boundary' },
  { id: 'label', label: 'Text' },
]

const SNAPS: { id: SnapKind; label: string; hint: string }[] = [
  { id: 'angle', label: 'Angles', hint: 'Lock to 0°, 45° and 90° from connected stations' },
  {
    id: 'levels',
    label: 'Parallel tracks',
    hint: 'Land on any single line through a shared stop, or on the track just outside it',
  },
  { id: 'grid', label: 'Grid', hint: 'Land on the grid pitch' },
  { id: 'align', label: 'Alignment', hint: 'Line up with any station on screen' },
  { id: 'spacing', label: 'Even spacing', hint: 'Match the gap to the previous stop' },
]

export function Toolbar({ onExport, onHelp }: { onExport: () => void; onHelp: () => void }) {
  const project = useEditor((s) => s.project)
  const space = useEditor((s) => s.space)
  const tool = useEditor((s) => s.tool)
  const dirty = useEditor((s) => s.dirty)
  const snapSuspended = useEditor((s) => s.snapSuspended)
  const terrainKind = useEditor((s) => s.terrainKind)
  const setSpace = useEditor((s) => s.setSpace)
  const setTool = useEditor((s) => s.setTool)
  const setSnap = useEditor((s) => s.setSnap)
  const setTerrainKind = useEditor((s) => s.setTerrainKind)
  const renameProject = useEditor((s) => s.renameProject)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const past = useEditor((s) => s.past)
  const future = useEditor((s) => s.future)

  if (!project) return null
  const activeSnaps = SNAPS.filter((s) => project.snap[s.id]).length

  return (
    <header className="z-30 shrink-0 border-b border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          value={project.name}
          onChange={(e) => renameProject(e.target.value)}
          className="w-40 shrink-0 rounded-md border border-transparent px-2 py-1 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-slate-900 focus:outline-none"
          aria-label="Project name"
        />

        <Divider />

        <Segmented
          value={space}
          onChange={(v) => setSpace(v as Space)}
          options={[
            { value: 'geo', label: 'Map', icon: <IconGlobe size={14} />, hint: 'The real layout, over your screenshots (G)' },
            { value: 'schematic', label: 'Diagram', icon: <IconDiagram size={14} />, hint: 'The tidied-up transit diagram (G)' },
          ]}
        />

        <Divider />

        <div className="flex items-center gap-0.5">
          {TOOLS.map((t) => (
            <ToolButton
              key={t.id}
              label={t.label}
              hint={t.hint}
              icon={t.icon}
              active={tool === t.id}
              onClick={() => setTool(t.id)}
            />
          ))}
        </div>

        <Divider />

        <Popover
          width="w-72"
          trigger={({ open, toggle }) => (
            <button
              onClick={toggle}
              aria-expanded={open}
              title="Snapping options"
              className={`inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                snapSuspended
                  ? 'bg-amber-100 text-amber-900'
                  : open
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <IconMagnet size={16} />
              {snapSuspended ? 'Snapping off' : `Snapping ${activeSnaps}/${SNAPS.length}`}
            </button>
          )}
        >
          <div className="space-y-2.5">
            <p className="text-[11px] leading-relaxed text-slate-500">
              Guides come from the stations a stop connects to. Hold <Kbd>Alt</Kbd> while
              dragging to place something exactly where the cursor is.
            </p>
            <div className="space-y-1 border-t border-slate-200 pt-2.5">
              {SNAPS.map((s) => (
                <Toggle
                  key={s.id}
                  label={s.label}
                  hint={s.hint}
                  checked={project.snap[s.id]}
                  onChange={(v) => setSnap({ [s.id]: v })}
                />
              ))}
            </div>
            <div className="border-t border-slate-200 pt-2.5">
              <Slider
                label="Grid pitch"
                value={project.snap.gridSize}
                min={5}
                max={60}
                step={5}
                onChange={(v) => setSnap({ gridSize: v })}
              />
            </div>
          </div>
        </Popover>

        <div className="ml-auto flex items-center gap-0.5">
          <HealthChip />
          <IconButton label="Zoom to fit (F)" size="md" onClick={() => requestFit('all')}>
            <IconFit size={16} />
          </IconButton>
          <IconButton label="Undo (Ctrl+Z)" size="md" disabled={past.length === 0} onClick={undo}>
            <IconUndo size={16} />
          </IconButton>
          <IconButton
            label="Redo (Ctrl+Shift+Z)"
            size="md"
            disabled={future.length === 0}
            onClick={redo}
          >
            <IconRedo size={16} />
          </IconButton>
          <IconButton label="Keyboard shortcuts (?)" size="md" onClick={onHelp}>
            <IconHelp size={16} />
          </IconButton>

          <span
            className="ml-1 mr-1 w-11 shrink-0 text-right font-mono text-[10px] text-slate-400"
            title={dirty ? 'Saving to this browser' : 'Saved to this browser'}
          >
            {dirty ? 'saving' : 'saved'}
          </span>

          <Button variant="primary" size="md" onClick={onExport}>
            <IconExport size={15} />
            Export
          </Button>
        </div>
      </div>

      {tool === 'terrain' && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50 px-3 py-1.5">
          <SectionLabel>Tracing</SectionLabel>
          <div className="flex gap-1">
            {TERRAIN_KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setTerrainKind(k.id)}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                  terrainKind === k.id
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-200'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-500">
            {terrainKind === 'label'
              ? 'Click where the text should sit, then type it in the panel on the right'
              : 'Click to add points · ↵ or double-click to finish · Esc to cancel'}
          </span>
        </div>
      )}
    </header>
  )
}

/** Validation surfaced in the toolbar rather than buried in a tab nobody opens. */
function HealthChip() {
  const project = useEditor((s) => s.project)!
  const select = useEditor((s) => s.select)
  const issues = useMemo(() => validateProject(project), [project])
  const counts = summarizeIssues(issues)
  const bad = counts.errors + counts.warnings

  return (
    <Popover
      align="right"
      width="w-80"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          title="Network checks"
          className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors ${
            counts.errors > 0
              ? 'text-red-700 hover:bg-red-50'
              : bad > 0
                ? 'text-amber-700 hover:bg-amber-50'
                : 'text-slate-400 hover:bg-slate-100'
          }`}
        >
          {bad > 0 ? <IconWarn size={15} /> : <IconCheck size={15} />}
          {bad > 0 ? bad : ''}
        </button>
      )}
    >
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-900">Network checks</p>
        {issues.length === 0 ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-emerald-900">
            Nothing to flag — the network is consistent.
          </p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {issues.map((i) => (
              <li key={i.id}>
                <button
                  onClick={() => select({ stations: i.stationIds ?? [], lines: i.lineIds ?? [] })}
                  className={`block w-full rounded-lg border px-2.5 py-2 text-left ${
                    i.severity === 'error'
                      ? 'border-red-200 bg-red-50 text-red-900'
                      : i.severity === 'warning'
                        ? 'border-amber-200 bg-amber-50 text-amber-900'
                        : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  <span className="block text-[11.5px] font-semibold">{i.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed opacity-80">
                    {i.detail}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Left panel
// ---------------------------------------------------------------------------

type Tab = 'lines' | 'stations' | 'layers' | 'route' | 'data'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'lines', label: 'Lines', icon: <IconLine size={14} /> },
  { id: 'stations', label: 'Stops', icon: <IconStation size={14} /> },
  { id: 'layers', label: 'Layers', icon: <IconLayers size={14} /> },
  { id: 'route', label: 'Route', icon: <IconBranch size={14} /> },
  { id: 'data', label: 'Data', icon: <IconData size={14} /> },
]

export function LeftPanel() {
  const [tab, setTab] = useState<Tab>('lines')
  const project = useEditor((s) => s.project)
  if (!project) return null

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex shrink-0 gap-0.5 border-b border-slate-200 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-medium transition-colors ${
              tab === t.id
                ? 'bg-slate-900 text-white'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'lines' && <LinesTab />}
        {tab === 'stations' && <StationsTab />}
        {tab === 'layers' && <LayersTab />}
        {tab === 'route' && <RouteTab />}
        {tab === 'data' && <DataTab />}
      </div>
    </aside>
  )
}

function LinesTab() {
  const project = useEditor((s) => s.project)!
  const selection = useEditor((s) => s.selection)
  const activeLineId = useEditor((s) => s.activeLineId)
  const addLine = useEditor((s) => s.addLine)
  const updateLine = useEditor((s) => s.updateLine)
  const reorderLine = useEditor((s) => s.reorderLine)
  const select = useEditor((s) => s.select)
  const setActiveLine = useEditor((s) => s.setActiveLine)
  const setTool = useEditor((s) => s.setTool)
  const network = networkOf(project)

  return (
    <div className="space-y-3">
      <Button
        variant="primary"
        size="md"
        className="w-full"
        onClick={() => {
          addLine()
          setTool('line')
        }}
      >
        <IconPlus size={15} />
        New line
      </Button>

      {project.lines.length === 0 ? (
        <EmptyState
          title="No lines yet"
          body={
            project.stations.length === 0
              ? 'Place a few stations first, then connect them into a route.'
              : 'Create a line, then click its stations in order.'
          }
        />
      ) : (
        <>
          <ul className="space-y-1">
            {project.lines.map((line, i) => {
              const stops = line.branches.reduce((n, b) => n + b.stops.length, 0)
              const isActive = activeLineId === line.id
              const isSelected = selection.lines.includes(line.id)
              return (
                <li key={line.id}>
                  <div
                    className={`group rounded-lg border px-2 py-1.5 transition-colors ${
                      isSelected
                        ? 'border-slate-900 bg-slate-50'
                        : 'border-transparent hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10"
                        style={{ background: line.color }}
                      />
                      <button
                        onClick={() => {
                          select({ lines: [line.id] })
                          setActiveLine(line.id, line.branches[0]?.id ?? null)
                        }}
                        className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-slate-900"
                      >
                        {line.name || 'Untitled'}
                      </button>
                      <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <IconButton
                          label="Move up"
                          disabled={i === 0}
                          onClick={() => reorderLine(line.id, i - 1)}
                        >
                          <span className="text-[11px]">↑</span>
                        </IconButton>
                        <IconButton
                          label="Move down"
                          disabled={i === project.lines.length - 1}
                          onClick={() => reorderLine(line.id, i + 1)}
                        >
                          <span className="text-[11px]">↓</span>
                        </IconButton>
                      </span>
                      <IconButton
                        label={line.hidden ? 'Show line' : 'Hide line'}
                        onClick={() => updateLine(line.id, { hidden: !line.hidden })}
                      >
                        {line.hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                      </IconButton>
                    </div>
                    <p className="mt-0.5 pl-5 font-mono text-[10px] text-slate-400">
                      {modeById(project.modes, line.mode).name} · {stops} stop
                      {stops === 1 ? '' : 's'}
                      {line.branches.length > 1 && ` · ${line.branches.length} branches`}
                    </p>
                    {isActive && (
                      <p className="mt-1.5 rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
                        Click stations on the map to add stops
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="px-1 text-[11px] leading-relaxed text-slate-400">
            Order matters: where lines share a corridor, this list decides which sits on
            which side.
          </p>
        </>
      )}

      {network.interchanges.size > 0 && (
        <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500">
          {network.interchanges.size} interchange
          {network.interchanges.size === 1 ? '' : 's'} found automatically.
        </p>
      )}
    </div>
  )
}

function StationsTab() {
  const project = useEditor((s) => s.project)!
  const selection = useEditor((s) => s.selection)
  const select = useEditor((s) => s.select)
  const setTool = useEditor((s) => s.setTool)
  const [q, setQ] = useState('')
  const network = networkOf(project)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? project.stations.filter((s) => s.name.toLowerCase().includes(needle))
      : project.stations
    return [...list].sort((a, b) => (a.name || '~').localeCompare(b.name || '~'))
  }, [project.stations, q])

  if (project.stations.length === 0) {
    return (
      <EmptyState
        title="No stations yet"
        body="Pick the station tool and click the map to drop your first stop."
        action={
          <Button variant="secondary" onClick={() => setTool('station')}>
            <IconStation size={14} />
            Place stations
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Filter ${project.stations.length} stations`}
        className={inputClass}
      />
      <ul className="space-y-0.5">
        {filtered.map((s) => {
          const count = network.linesAtStation.get(s.id)?.length ?? 0
          return (
            <li key={s.id}>
              <button
                onClick={() => {
                  select({ stations: [s.id] })
                  requestFit('selection')
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                  selection.stations.includes(s.id)
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{s.name || 'Unnamed'}</span>
                <span className="shrink-0 font-mono text-[10px] opacity-60">
                  {count === 0 ? 'orphan' : `${count}×`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {filtered.length === 0 && (
        <p className="px-1 py-3 text-center text-[11px] text-slate-400">
          Nothing matches “{q}”.
        </p>
      )}
    </div>
  )
}

const TERRAIN_LABEL: Record<string, string> = {
  waterway: 'River',
  water: 'Water',
  green: 'Park',
  builtup: 'Built-up',
  boundary: 'Boundary',
  label: 'Text',
}

function LayersTab() {
  const project = useEditor((s) => s.project)!
  const space = useEditor((s) => s.space)
  const selection = useEditor((s) => s.selection)
  const select = useEditor((s) => s.select)
  const setTool = useEditor((s) => s.setTool)
  const updateTerrain = useEditor((s) => s.updateTerrain)
  const deleteTerrain = useEditor((s) => s.deleteTerrain)
  const simplifyTerrain = useEditor((s) => s.simplifyTerrain)
  const resetTerrain = useEditor((s) => s.resetTerrainToGeographic)
  const addImage = useEditor((s) => s.addImage)
  const updateImage = useEditor((s) => s.updateImage)
  const deleteImages = useEditor((s) => s.deleteImages)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const doImport = async () => {
    const files = await pickFiles('image/*', true)
    if (files.length === 0) return
    setBusy(true)
    setNote(null)
    try {
      const imported = await importImageFiles(files)
      for (const i of imported) addImage(i.layer)
      const shrunk = imported.filter((i) => i.downscaled).length
      if (shrunk > 0) {
        setNote(
          `${shrunk} image${shrunk === 1 ? ' was' : 's were'} downscaled to keep the canvas within safe limits.`,
        )
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not import those images.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Screenshots</SectionLabel>
          <Button onClick={doImport} disabled={busy}>
            <IconPlus size={13} />
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </div>

        {note && (
          <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900">
            {note}
          </p>
        )}

        {project.images.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-slate-400">
            Nothing imported. Screenshots sit under the map so you can trace on top; they
            never appear in the diagram.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {project.images.map((img: ImageLayer) => (
              <li key={img.id} className="rounded-lg border border-slate-200 p-2">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-800">
                    {img.name}
                  </span>
                  <button
                    onClick={() => updateImage(img.id, { locked: !img.locked })}
                    title={img.locked ? 'Unlock to move' : 'Lock in place'}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      img.locked ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-100'
                    }`}
                  >
                    {img.locked ? 'locked' : 'free'}
                  </button>
                  <IconButton
                    label={img.hidden ? 'Show' : 'Hide'}
                    onClick={() => updateImage(img.id, { hidden: !img.hidden })}
                  >
                    {img.hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                  </IconButton>
                  <IconButton
                    label="Delete image"
                    variant="danger"
                    onClick={() => deleteImages([img.id])}
                  >
                    <IconTrash size={13} />
                  </IconButton>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={img.opacity}
                    onChange={(e) => updateImage(img.id, { opacity: Number(e.target.value) })}
                    className="flex-1 accent-slate-900"
                    aria-label={`Opacity of ${img.name}`}
                  />
                  <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-400">
                    {Math.round(img.opacity * 100)}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-3">
        <div className="flex items-center justify-between">
          <SectionLabel>Terrain</SectionLabel>
          <Button onClick={() => setTool('terrain')}>
            <IconPlus size={13} />
            Trace
          </Button>
        </div>

        {project.terrain.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-slate-400">
            Trace the river and coast over your screenshots, then simplify them into
            straight strokes for the diagram.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {project.terrain.map((t) => {
              const isSel = selection.terrain.includes(t.id)
              return (
                <li
                  key={t.id}
                  className={`rounded-lg border p-2 ${
                    isSel ? 'border-slate-900 bg-slate-50' : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => select({ terrain: [t.id] })}
                      className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-slate-800"
                    >
                      {t.name || TERRAIN_LABEL[t.kind] || t.kind}
                    </button>
                    <IconButton
                      label={t.hidden ? 'Show' : 'Hide'}
                      onClick={() => updateTerrain(t.id, { hidden: !t.hidden })}
                    >
                      {t.hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                    </IconButton>
                    <IconButton
                      label="Delete shape"
                      variant="danger"
                      onClick={() => deleteTerrain([t.id])}
                    >
                      <IconTrash size={13} />
                    </IconButton>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-slate-400">
                    {TERRAIN_LABEL[t.kind] ?? t.kind} · {t.geo.length} traced ·{' '}
                    {t.schematic.length} on diagram
                  </p>
                  {isSel && (
                    <div className="mt-2 space-y-2">
                      <input
                        value={t.name}
                        onChange={(e) => updateTerrain(t.id, { name: e.target.value })}
                        placeholder="Name, e.g. River Ald"
                        className={inputClass}
                      />
                      {space === 'schematic' ? (
                        <div className="flex flex-wrap gap-1">
                          <Button onClick={() => simplifyTerrain(t.id, 8)}>Simplify</Button>
                          <Button onClick={() => simplifyTerrain(t.id, 30)}>Simplify hard</Button>
                          <Button variant="quiet" onClick={() => resetTerrain([t.id])}>
                            Reset
                          </Button>
                        </div>
                      ) : (
                        <p className="text-[11px] leading-relaxed text-slate-500">
                          Switch to the diagram to simplify this into straight strokes.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function DataTab() {
  const project = useEditor((s) => s.project)!
  const mutate = useEditor((s) => s.mutate)
  const renameMany = useEditor((s) => s.renameMany)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')

  const doImport = async () => {
    setError(null)
    setReport(null)
    const [file] = await pickFiles('.csv,text/csv,text/plain')
    if (!file) return
    try {
      const rows = parseCsv(await file.text())
      let out: ImportReport | null = null
      mutate('Import CSV', (d) => {
        out = applyCsv(d, rows)
      })
      setReport(out)
      if (out && (out as ImportReport).shape === 'unknown') {
        setError((out as ImportReport).warnings[0] ?? 'Could not read that file.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.')
    }
  }

  const matches = useMemo(
    () => (find ? project.stations.filter((s) => s.name.includes(find)) : []),
    [project.stations, find],
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SectionLabel>Import</SectionLabel>
        <Button variant="primary" size="md" className="w-full" onClick={doImport}>
          Import a CSV
        </Button>
        <p className="text-[11px] leading-relaxed text-slate-500">
          A header of <code className="font-mono text-slate-700">name,x,y</code> brings in
          stations. <code className="font-mono text-slate-700">line,stop</code> brings in
          routes, one row per stop in order. Existing stations match by name.
        </p>
        {error && (
          <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900">
            {error}
          </p>
        )}
        {report && report.shape !== 'unknown' && (
          <div className="rounded-lg bg-emerald-50 px-2.5 py-2 text-[11px] leading-relaxed text-emerald-900">
            <p>
              {report.stationsAdded} added · {report.stationsMatched} matched ·{' '}
              {report.linesAdded} lines · {report.stopsAdded} stops
            </p>
            {report.warnings.slice(0, 3).map((w, i) => (
              <p key={i} className="mt-1 opacity-80">
                {w}
              </p>
            ))}
            {report.warnings.length > 3 && (
              <p className="mt-1 opacity-70">…and {report.warnings.length - 3} more.</p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-3">
        <SectionLabel>Export as spreadsheet</SectionLabel>
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => downloadText(stationsToCsv(project), 'stations.csv', 'text/csv')}
          >
            Stations
          </Button>
          <Button
            className="flex-1"
            onClick={() => downloadText(linesToCsv(project), 'lines.csv', 'text/csv')}
          >
            Lines
          </Button>
        </div>
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-3">
        <SectionLabel>Rename in bulk</SectionLabel>
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find in station names"
          className={inputClass}
        />
        <input
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          placeholder="Replace with"
          className={inputClass}
        />
        <Button
          className="w-full"
          disabled={matches.length === 0}
          onClick={() => {
            renameMany(
              matches.map((s) => ({ id: s.id, name: s.name.split(find).join(replace) })),
              `Replace "${find}" in ${matches.length} names`,
            )
            setFind('')
            setReplace('')
          }}
        >
          {find
            ? `Replace in ${matches.length} name${matches.length === 1 ? '' : 's'}`
            : 'Replace'}
        </Button>
        {matches.length > 0 && (
          <ul className="max-h-28 overflow-y-auto rounded-lg bg-slate-50 p-2">
            {matches.slice(0, 12).map((s) => (
              <li key={s.id} className="truncate font-mono text-[10px] text-slate-500">
                {s.name} → {s.name.split(find).join(replace)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export function Inspector() {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  if (!project) return null

  const crossingKey =
    selection.crossings.length === 1 ? selection.crossings[0] : undefined
  const transfer =
    selection.transfers.length === 1
      ? project.transfers.find((t) => t.id === selection.transfers[0])
      : undefined
  const station =
    selection.stations.length === 1
      ? project.stations.find((s) => s.id === selection.stations[0])
      : undefined
  const line =
    selection.lines.length === 1
      ? project.lines.find((l) => l.id === selection.lines[0])
      : undefined

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white p-3">
      {crossingKey ? (
        <CrossingInspector crossingKey={crossingKey} />
      ) : transfer ? (
        <TransferInspector id={transfer.id} />
      ) : station ? (
        <StationInspector id={station.id} />
      ) : line ? (
        <LineInspector line={line} />
      ) : selection.stations.length > 1 ? (
        <MultiStationInspector ids={selection.stations} />
      ) : (
        <NothingSelected />
      )}
    </aside>
  )
}

function NothingSelected() {
  const project = useEditor((s) => s.project)!
  const setStyle = useEditor((s) => s.setStyle)
  const setView = useEditor((s) => s.setView)
  const applyPreset = useEditor((s) => s.applyStylePreset)
  const space = useEditor((s) => s.space)

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-slate-50 px-3 py-3">
        <p className="text-[12px] font-semibold text-slate-800">Nothing selected</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500">
          Click a station or a line on the map to edit it. Drag on empty space to select
          several at once.
        </p>
      </div>

      <Section title="Look of the map" defaultOpen>
        <Field label="Preset">
          <select
            value={project.style.presetId}
            onChange={(e) => applyPreset(e.target.value)}
            className={inputClass}
          >
            {STYLE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-[11px] leading-relaxed text-slate-500">
          {STYLE_PRESETS.find((p) => p.id === project.style.presetId)?.description}
        </p>
      </Section>

      <Section title="Fine tuning">
        <Slider
          label="Corridor spacing"
          value={project.style.corridorSpacing}
          min={4}
          max={24}
          onChange={(v) => setStyle({ corridorSpacing: v })}
        />
        <Slider
          label="Corner radius"
          value={project.style.cornerRadius}
          min={0}
          max={30}
          onChange={(v) => setStyle({ cornerRadius: v })}
        />
        <Slider
          label="Crossing gap — length"
          value={project.style.casingLength}
          min={0}
          max={12}
          step={0.5}
          onChange={(v) => setStyle({ casingLength: v })}
        />
        <Slider
          label="Crossing gap — height"
          value={project.style.casingHeight}
          min={0}
          max={12}
          step={0.5}
          onChange={(v) => setStyle({ casingHeight: v })}
        />
        <Slider
          label="Station size"
          value={project.style.stationRadius}
          min={3}
          max={14}
          step={0.5}
          onChange={(v) => setStyle({ stationRadius: v })}
        />
        <Slider
          label="Label size"
          value={project.style.fontSize}
          min={8}
          max={22}
          step={0.5}
          onChange={(v) => setStyle({ fontSize: v })}
        />
        <Slider
          label="Line thickness"
          value={project.style.strokeScale}
          min={0.5}
          max={2}
          step={0.05}
          onChange={(v) => setStyle({ strokeScale: v })}
        />
      </Section>

      <Section title="Transport modes">
        <ModeEditor />
      </Section>

      <Section title="What to show">
        <Toggle
          label="Station labels"
          checked={project.view.showLabels}
          onChange={(v) => setView({ showLabels: v })}
        />
        <Toggle
          label="Place labels automatically"
          hint="Labels you drag by hand are left alone"
          checked={project.view.autoLabels}
          onChange={(v) => setView({ autoLabels: v })}
        />
        <Toggle
          label="Route badges at line ends"
          hint="The coloured bullet naming each line at its terminus"
          checked={project.view.showLineBadges}
          onChange={(v) => setView({ showLineBadges: v })}
        />
        <Toggle
          label="Terrain"
          checked={project.view.showTerrain}
          onChange={(v) => setView({ showTerrain: v })}
        />
        {space === 'geo' && (
          <Toggle
            label="Screenshots"
            checked={project.view.showScreenshots}
            onChange={(v) => setView({ showScreenshots: v })}
          />
        )}
        {space === 'schematic' && (
          <>
            <Toggle
              label="Grid dots"
              checked={project.view.showGrid}
              onChange={(v) => setView({ showGrid: v })}
            />
            <Toggle
              label="True-position ghosts"
              hint="Shows how far each station has moved from reality"
              checked={project.view.showGeoGhosts}
              onChange={(v) => setView({ showGeoGhosts: v })}
            />
          </>
        )}
      </Section>
    </div>
  )
}

function StationInspector({ id }: { id: StationId }) {
  const project = useEditor((s) => s.project)!
  const space = useEditor((s) => s.space)
  const renameStation = useEditor((s) => s.renameStation)
  const deleteStations = useEditor((s) => s.deleteStations)
  const resetToGeographic = useEditor((s) => s.resetToGeographic)
  const resetLabel = useEditor((s) => s.resetLabel)
  const setLabel = useEditor((s) => s.setLabel)
  const station = project.stations.find((s) => s.id === id)
  if (!station) return null

  const network = networkOf(project)
  const serving = network.linesAtStation.get(id) ?? []
  const drift = Math.round(
    Math.hypot(station.schematic.x - station.geo.x, station.schematic.y - station.geo.y),
  )

  return (
    <div className="space-y-3">
      <SectionLabel>Station</SectionLabel>

      <input
        value={station.name}
        onChange={(e) => renameStation(id, e.target.value)}
        placeholder="Name this stop"
        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm font-medium focus:border-slate-900 focus:outline-none"
      />

      <div>
        <SectionLabel>
          Served by {serving.length} line{serving.length === 1 ? '' : 's'}
        </SectionLabel>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {serving.map((lid) => {
            const l = project.lines.find((x) => x.id === lid)
            if (!l) return null
            return (
              <span
                key={lid}
                className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-white"
                style={{ background: l.color }}
              >
                {l.name}
              </span>
            )
          })}
          {serving.length === 0 && (
            <span className="text-[11.5px] text-slate-400">
              Not on a line yet — build one and click this stop.
            </span>
          )}
        </div>
      </div>

      <Section title="Position">
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-slate-500">
          <span>
            <span className="block text-[9px] uppercase tracking-wider text-slate-400">Map</span>
            {Math.round(station.geo.x)}, {Math.round(station.geo.y)}
          </span>
          <span>
            <span className="block text-[9px] uppercase tracking-wider text-slate-400">
              Diagram
            </span>
            {Math.round(station.schematic.x)}, {Math.round(station.schematic.y)}
          </span>
        </div>
        {drift > 1 && (
          <p className="text-[11px] leading-relaxed text-slate-500">
            Moved {drift}px from its real position.
          </p>
        )}
        {space === 'schematic' && drift > 1 && (
          <Button className="w-full" onClick={() => resetToGeographic([id])}>
            Put it back where it really is
          </Button>
        )}
      </Section>

      <StationTransfers id={id} />

      <Section title="Label">
        <p className="text-[11px] leading-relaxed text-slate-500">
          {station.label.pinned
            ? `Pinned to the ${station.label.anchor}.`
            : 'Placed automatically. Drag it on the map to pin it.'}
        </p>
        {station.label.pinned && (
          <Button className="w-full" onClick={() => resetLabel(id)}>
            Hand back to auto-placement
          </Button>
        )}
        <Toggle
          label="Show this label"
          checked={!station.label.hidden}
          onChange={(v) => setLabel(id, { hidden: !v })}
        />
      </Section>

      <div className="border-t border-slate-200 pt-3">
        <Button variant="danger" className="w-full" onClick={() => deleteStations([id])}>
          <IconTrash size={13} />
          Delete station
        </Button>
      </div>
    </div>
  )
}

function MultiStationInspector({ ids }: { ids: StationId[] }) {
  const space = useEditor((s) => s.space)
  const distribute = useEditor((s) => s.distributeEvenly)
  const align = useEditor((s) => s.alignStations)
  const deleteStations = useEditor((s) => s.deleteStations)
  const resetToGeographic = useEditor((s) => s.resetToGeographic)
  const addTransfer = useEditor((s) => s.addTransfer)

  return (
    <div className="space-y-3">
      <SectionLabel>{ids.length} stations selected</SectionLabel>
      <p className="text-[11.5px] leading-relaxed text-slate-500">
        Drag any one of them to move the whole group. Snapping stays off for group moves so
        they keep their shape.
      </p>

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => align(ids, 'y', space)}>Align across</Button>
          <Button onClick={() => align(ids, 'x', space)}>Align down</Button>
        </div>
        <Button className="w-full" disabled={ids.length < 3} onClick={() => distribute(ids, space)}>
          Space them evenly
        </Button>
        {ids.length === 2 && (
          <>
            <Button className="w-full" onClick={() => addTransfer(ids[0], ids[1])}>
              Link as an interchange
            </Button>
            <p className="text-[11px] leading-relaxed text-slate-400">
              For two separate stations you walk between — drawn as a dashed connector,
              and journeys can use it.
            </p>
          </>
        )}
        {space === 'schematic' && (
          <Button className="w-full" onClick={() => resetToGeographic(ids)}>
            Put them back where they really are
          </Button>
        )}
      </div>

      <div className="border-t border-slate-200 pt-3">
        <Button variant="danger" className="w-full" onClick={() => deleteStations(ids)}>
          <IconTrash size={13} />
          Delete {ids.length} stations
        </Button>
      </div>
    </div>
  )
}

function LineInspector({ line }: { line: Line }) {
  const project = useEditor((s) => s.project)!
  const updateLine = useEditor((s) => s.updateLine)
  const deleteLine = useEditor((s) => s.deleteLine)
  const duplicateLine = useEditor((s) => s.duplicateLine)
  const straighten = useEditor((s) => s.straightenLine)
  const addBranch = useEditor((s) => s.addBranch)
  const deleteBranch = useEditor((s) => s.deleteBranch)
  const reverseBranch = useEditor((s) => s.reverseBranch)
  const removeStop = useEditor((s) => s.removeStop)
  const setActiveLine = useEditor((s) => s.setActiveLine)
  const setTool = useEditor((s) => s.setTool)
  const select = useEditor((s) => s.select)
  const activeBranchId = useEditor((s) => s.activeBranchId)

  const nameOf = (id: StationId) =>
    project.stations.find((s) => s.id === id)?.name || 'Unnamed'

  return (
    <div className="space-y-3">
      <SectionLabel>Line</SectionLabel>

      <input
        value={line.name}
        onChange={(e) => updateLine(line.id, { name: e.target.value })}
        placeholder="Name this line"
        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm font-medium focus:border-slate-900 focus:outline-none"
      />

      <Field label="Mode" hint="Sets the stroke weight, dash pattern and station symbol.">
        <select
          value={line.mode}
          onChange={(e) => updateLine(line.id, { mode: e.target.value })}
          className={inputClass}
        >
          {project.modes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>

      <div>
        <SectionLabel>Colour</SectionLabel>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {LINE_PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => updateLine(line.id, { color: c })}
              title={c}
              className={`h-5 w-5 rounded ring-1 ring-black/10 transition-transform hover:scale-110 ${
                line.color.toLowerCase() === c.toLowerCase()
                  ? 'ring-2 ring-slate-900 ring-offset-1'
                  : ''
              }`}
              style={{ background: c }}
              aria-label={`Use ${c}`}
            />
          ))}
          <label
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-slate-400 ring-1 ring-slate-300 hover:text-slate-700"
            title="Custom colour"
          >
            <input
              type="color"
              value={line.color}
              onChange={(e) => updateLine(line.id, { color: e.target.value })}
              className="h-0 w-0 opacity-0"
            />
            <IconPlus size={11} />
          </label>
        </div>
      </div>

      <Section
        title={`Route — ${line.branches.length} branch${line.branches.length === 1 ? '' : 'es'}`}
        defaultOpen
      >
        {line.branches.map((b, bi) => (
          <div key={b.id} className="rounded-lg border border-slate-200 p-2">
            <div className="mb-1 flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-500">
                {b.name || `Branch ${bi + 1}`} · {b.stops.length}
              </span>
              <Button
                variant={activeBranchId === b.id ? 'primary' : 'ghost'}
                onClick={() => {
                  setActiveLine(line.id, b.id)
                  setTool('line')
                }}
              >
                {activeBranchId === b.id ? 'Adding…' : 'Add stops'}
              </Button>
              <IconButton label="Reverse direction" onClick={() => reverseBranch(line.id, b.id)}>
                <span className="text-[11px]">⇄</span>
              </IconButton>
              {line.branches.length > 1 && (
                <IconButton
                  label="Delete branch"
                  variant="danger"
                  onClick={() => deleteBranch(line.id, b.id)}
                >
                  <IconTrash size={12} />
                </IconButton>
              )}
            </div>
            {b.stops.length === 0 ? (
              <p className="px-1 py-1 text-[11px] text-slate-400">
                Empty — hit “Add stops”, then click stations.
              </p>
            ) : (
              <ol className="space-y-0.5">
                {b.stops.map((sid, i) => (
                  <li key={`${sid}-${i}`} className="group flex items-center gap-1">
                    <span className="w-4 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-300">
                      {i + 1}
                    </span>
                    <button
                      onClick={() => select({ stations: [sid] })}
                      className="min-w-0 flex-1 truncate text-left text-[11.5px] text-slate-700 hover:text-slate-900 hover:underline"
                    >
                      {nameOf(sid)}
                    </button>
                    <IconButton
                      label="Remove this stop"
                      className="opacity-0 focus:opacity-100 group-hover:opacity-100"
                      onClick={() => removeStop(line.id, b.id, i)}
                    >
                      <span className="text-[11px]">×</span>
                    </IconButton>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}

        <Button
          className="w-full"
          onClick={() => {
            addBranch(line.id)
            setTool('line')
          }}
        >
          <IconBranch size={13} />
          Add a branch
        </Button>
        <p className="text-[11px] leading-relaxed text-slate-400">
          A branch lets one line fork — start it at a station already on the route.
        </p>
      </Section>

      <CorridorInspector lineId={line.id} />

      <Section title="Actions" defaultOpen>
        <Button className="w-full" onClick={() => straighten(line.id)}>
          <IconStraighten size={13} />
          Straighten this line
        </Button>
        <Button className="w-full" onClick={() => duplicateLine(line.id)}>
          Duplicate
        </Button>
        <Button variant="danger" className="w-full" onClick={() => deleteLine(line.id)}>
          <IconTrash size={13} />
          Delete line
        </Button>
      </Section>
    </div>
  )
}

export function CorridorInspector({ lineId }: { lineId: LineId }) {
  const project = useEditor((s) => s.project)!
  const setCorridorOrder = useEditor((s) => s.setCorridorOrder)
  const network = networkOf(project)

  const shared = useMemo(() => {
    const out: { key: string; lines: LineId[] }[] = []
    for (const [key, ids] of network.corridors) {
      if (ids.length > 1 && ids.includes(lineId)) out.push({ key, lines: ids })
    }
    return out
  }, [network, lineId])

  if (shared.length === 0) return null

  const nameOf = (id: StationId) =>
    project.stations.find((s) => s.id === id)?.name || 'Unnamed'

  const move = (key: string, ids: LineId[], from: number, to: number) => {
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    const [x] = next.splice(from, 1)
    next.splice(to, 0, x)
    setCorridorOrder(key, next)
  }

  return (
    <Section title={`Shared with other lines (${shared.length})`}>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Where lines run together they are drawn side by side. This order decides which sits
        on which side.
      </p>
      {shared.slice(0, 6).map(({ key, lines }) => {
        const [a, b] = splitSegmentKey(key)
        return (
          <div key={key} className="rounded-lg border border-slate-200 p-2">
            <p className="mb-1 truncate font-mono text-[10px] text-slate-500">
              {nameOf(a)} – {nameOf(b)}
            </p>
            <ul className="space-y-0.5">
              {lines.map((id, i) => {
                const l = project.lines.find((x) => x.id === id)
                if (!l) return null
                return (
                  <li key={id} className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10"
                      style={{ background: l.color }}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-[11.5px] ${
                        id === lineId ? 'font-semibold text-slate-900' : 'text-slate-600'
                      }`}
                    >
                      {l.name}
                    </span>
                    <IconButton
                      label="Move to the other side"
                      disabled={i === 0}
                      onClick={() => move(key, lines, i, i - 1)}
                    >
                      <span className="text-[11px]">↑</span>
                    </IconButton>
                    <IconButton
                      label="Move to the other side"
                      disabled={i === lines.length - 1}
                      onClick={() => move(key, lines, i, i + 1)}
                    >
                      <span className="text-[11px]">↓</span>
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      {shared.length > 6 && (
        <p className="font-mono text-[10px] text-slate-400">
          …and {shared.length - 6} more. Reordering the Lines list changes them all at once.
        </p>
      )}
    </Section>
  )
}


// ---------------------------------------------------------------------------
// Route planner
// ---------------------------------------------------------------------------

function RouteTab() {
  const project = useEditor((s) => s.project)!
  const routeFrom = useEditor((s) => s.routeFrom)
  const routeTo = useEditor((s) => s.routeTo)
  const route = useEditor((s) => s.route)
  const routePick = useEditor((s) => s.routePick)
  const setRouteEnd = useEditor((s) => s.setRouteEnd)
  const setRoutePick = useEditor((s) => s.setRoutePick)
  const clearRoute = useEditor((s) => s.clearRoute)
  const select = useEditor((s) => s.select)

  const nameOf = (id: StationId | null) =>
    id ? project.stations.find((s) => s.id === id)?.name || 'Unnamed' : null

  const named = useMemo(
    () => [...project.stations].sort((a, b) => (a.name || '~').localeCompare(b.name || '~')),
    [project.stations],
  )

  const End = ({ which }: { which: 'from' | 'to' }) => {
    const id = which === 'from' ? routeFrom : routeTo
    const picking = routePick === which
    return (
      <div className="space-y-1">
        <SectionLabel>{which === 'from' ? 'From' : 'To'}</SectionLabel>
        <div className="flex gap-1">
          <select
            value={id ?? ''}
            onChange={(e) => setRouteEnd(which, (e.target.value || null) as StationId | null)}
            className={inputClass}
          >
            <option value="">Choose a stop…</option>
            {named.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || 'Unnamed'}
              </option>
            ))}
          </select>
          <Button
            variant={picking ? 'primary' : 'secondary'}
            onClick={() => setRoutePick(picking ? null : which)}
            title="Pick this stop by clicking it on the map"
          >
            Pick
          </Button>
        </div>
      </div>
    )
  }

  if (project.stations.length < 2) {
    return (
      <EmptyState
        title="Not enough to plan with"
        body="Add a couple of stations and a line, then you can trace a journey across the network."
      />
    )
  }

  return (
    <div className="space-y-3">
      <End which="from" />
      <End which="to" />

      {routePick && (
        <p className="rounded-lg bg-emerald-50 px-2.5 py-2 text-[11px] text-emerald-800">
          Click a station on the map to set the {routePick === 'from' ? 'start' : 'end'}.
        </p>
      )}

      {routeFrom && routeTo && !route && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-900">
          No way to get between these two. They may be on separate parts of the network —
          an out-of-station link would join them up.
        </p>
      )}

      {route && (
        <>
          <div className="rounded-xl bg-slate-900 px-3 py-2.5 text-white">
            <p className="text-lg font-semibold leading-none">
              {route.stopCount} stop{route.stopCount === 1 ? '' : 's'}
            </p>
            <p className="mt-1 text-[11.5px] opacity-75">
              {route.interchanges === 0 ? 'No changes' : `${route.interchanges} change${route.interchanges === 1 ? '' : 's'}`}
              {route.walks > 0 && ` · ${route.walks} walk${route.walks === 1 ? '' : 's'}`}
            </p>
          </div>

          <ol className="space-y-1.5">
            {route.legs.map((leg, i) => {
              const l = leg.lineId ? project.lines.find((x) => x.id === leg.lineId) : null
              return (
                <li key={i} className="rounded-lg border border-slate-200 p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10"
                      style={{ background: l?.color ?? 'transparent',
                               border: l ? undefined : '1.5px dashed currentColor' }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                      {l ? l.name : 'Walk between stations'}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-400">
                      {leg.stops.length - 1} stop{leg.stops.length - 1 === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="mt-1 pl-5 text-[11px] leading-relaxed text-slate-500">
                    {nameOf(leg.stops[0])} → {nameOf(leg.stops[leg.stops.length - 1])}
                  </p>
                </li>
              )
            })}
          </ol>

          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => select({ stations: route.path })}
            >
              Select the whole route
            </Button>
            <Button variant="quiet" onClick={clearRoute}>
              Clear
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transport modes
// ---------------------------------------------------------------------------

const SYMBOLS: { id: string; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'tick', label: 'Tick' },
  { id: 'square', label: 'Square' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'anchor', label: 'Anchor' },
]

export function ModeEditor() {
  const project = useEditor((s) => s.project)!
  const addMode = useEditor((s) => s.addMode)
  const updateMode = useEditor((s) => s.updateMode)
  const deleteMode = useEditor((s) => s.deleteMode)
  const [open, setOpen] = useState<string | null>(null)
  const [name, setName] = useState('')

  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of project.lines) m.set(l.mode, (m.get(l.mode) ?? 0) + 1)
    return m
  }, [project.lines])

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-relaxed text-slate-500">
        A mode sets how a line is drawn — its thickness, its dash pattern and the symbol
        used for its stops. Add your own for anything the built-ins do not cover.
      </p>

      <ul className="space-y-1">
        {project.modes.map((m) => {
          const count = usage.get(m.id) ?? 0
          const isOpen = open === m.id
          return (
            <li key={m.id} className="rounded-lg border border-slate-200">
              <div className="flex items-center gap-2 p-2">
                <span
                  className="h-2.5 w-6 shrink-0 rounded-full"
                  style={{ background: m.color }}
                />
                <button
                  onClick={() => setOpen(isOpen ? null : m.id)}
                  className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-slate-800"
                >
                  {m.name}
                </button>
                <span className="shrink-0 font-mono text-[10px] text-slate-400">
                  {count === 0 ? 'unused' : `${count}×`}
                </span>
              </div>

              {isOpen && (
                <div className="space-y-2 border-t border-slate-200 p-2">
                  <input
                    value={m.name}
                    onChange={(e) => updateMode(m.id, { name: e.target.value })}
                    className={inputClass}
                    placeholder="Name"
                  />
                  <Slider
                    label="Thickness"
                    value={m.strokeWidth}
                    min={1}
                    max={16}
                    step={0.5}
                    onChange={(v) => updateMode(m.id, { strokeWidth: v })}
                  />
                  <Field label="Stop symbol">
                    <select
                      value={m.stationSymbol}
                      onChange={(e) =>
                        updateMode(m.id, {
                          stationSymbol: e.target.value as typeof m.stationSymbol,
                        })
                      }
                      className={inputClass}
                    >
                      {SYMBOLS.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Dashes" hint="Leave blank for a solid line.">
                    <input
                      value={(m.dash ?? []).join(' ')}
                      onChange={(e) => {
                        const nums = e.target.value
                          .split(/[\s,]+/)
                          .map(Number)
                          .filter((n) => Number.isFinite(n) && n > 0)
                        updateMode(m.id, { dash: nums.length ? nums : undefined })
                      }}
                      placeholder="e.g. 10 6"
                      className={inputClass}
                    />
                  </Field>
                  <Slider
                    label="Draw order"
                    value={m.z}
                    min={0}
                    max={100}
                    step={5}
                    onChange={(v) => updateMode(m.id, { z: v })}
                  />
                  <Button
                    variant="danger"
                    className="w-full"
                    disabled={project.modes.length <= 1}
                    onClick={() => {
                      deleteMode(m.id)
                      setOpen(null)
                    }}
                  >
                    <IconTrash size={13} />
                    {count > 0 ? `Delete — ${count} line${count === 1 ? '' : 's'} will fall back` : 'Delete mode'}
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              addMode(name.trim())
              setName('')
            }
          }}
          placeholder="Monorail, funicular…"
          className={inputClass}
        />
        <Button
          disabled={!name.trim()}
          onClick={() => {
            addMode(name.trim())
            setName('')
          }}
        >
          <IconPlus size={13} />
          Add
        </Button>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Out-of-station interchanges
// ---------------------------------------------------------------------------

function StationTransfers({ id }: { id: StationId }) {
  const project = useEditor((s) => s.project)!
  const select = useEditor((s) => s.select)
  const deleteTransfer = useEditor((s) => s.deleteTransfer)

  const links = project.transfers.filter((t) => t.a === id || t.b === id)
  if (links.length === 0) return null

  const other = (t: (typeof links)[number]) => (t.a === id ? t.b : t.a)
  const nameOf = (sid: StationId) =>
    project.stations.find((s) => s.id === sid)?.name || 'Unnamed'

  return (
    <Section title={`Walking links (${links.length})`} defaultOpen>
      <ul className="space-y-1">
        {links.map((t) => (
          <li key={t.id} className="flex items-center gap-1.5">
            <button
              onClick={() => select({ transfers: [t.id] })}
              className="min-w-0 flex-1 truncate text-left text-[11.5px] text-slate-700 hover:underline"
            >
              {nameOf(other(t))}
              {t.note && <span className="text-slate-400"> · {t.note}</span>}
            </button>
            <IconButton
              label="Remove this link"
              variant="danger"
              onClick={() => deleteTransfer(t.id)}
            >
              <IconTrash size={12} />
            </IconButton>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function TransferInspector({ id }: { id: string }) {
  const project = useEditor((s) => s.project)!
  const updateTransfer = useEditor((s) => s.updateTransfer)
  const deleteTransfer = useEditor((s) => s.deleteTransfer)
  const select = useEditor((s) => s.select)
  const transfer = project.transfers.find((t) => t.id === id)
  if (!transfer) return null

  const nameOf = (sid: StationId) =>
    project.stations.find((s) => s.id === sid)?.name || 'Unnamed'

  return (
    <div className="space-y-3">
      <SectionLabel>Walking link</SectionLabel>

      <div className="rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-[12.5px] font-medium text-slate-800">
          {nameOf(transfer.a)} ↔ {nameOf(transfer.b)}
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500">
          Two separate stations you walk between. Journeys can use it, at a cost of
          several stops.
        </p>
      </div>

      <Field label="Note" hint="Shown along the link, e.g. “5 min walk”.">
        <input
          value={transfer.note}
          onChange={(e) => updateTransfer(transfer.id, { note: e.target.value })}
          placeholder="Optional"
          className={inputClass}
        />
      </Field>

      <Toggle
        label="Show on the map"
        checked={!transfer.hidden}
        onChange={(v) => updateTransfer(transfer.id, { hidden: !v })}
      />

      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => select({ stations: [transfer.a, transfer.b] })}>
          Select both stops
        </Button>
      </div>

      <div className="border-t border-slate-200 pt-3">
        <Button
          variant="danger"
          className="w-full"
          onClick={() => deleteTransfer(transfer.id)}
        >
          <IconTrash size={13} />
          Remove the link
        </Button>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// One crossing
// ---------------------------------------------------------------------------

function CrossingInspector({ crossingKey }: { crossingKey: string }) {
  const project = useEditor((s) => s.project)!
  const setOverride = useEditor((s) => s.setCrossingOverride)
  const clearOverride = useEditor((s) => s.clearCrossingOverride)
  const o = project.crossings[crossingKey] ?? {}

  // Which two lines meet here is recoverable from the key, which is built out of them.
  const lineNames = useMemo(() => {
    const parts = crossingKey.split('#')[0].split('|')
    return parts
      .map((half) => half.split('~')[0])
      .map((id) => project.lines.find((l) => l.id === id))
      .filter((l): l is (typeof project.lines)[number] => !!l)
  }, [crossingKey, project.lines])

  return (
    <div className="space-y-3">
      <SectionLabel>Crossing</SectionLabel>

      <div className="rounded-xl bg-slate-50 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {lineNames.map((l) => (
            <span
              key={l.id}
              className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-white"
              style={{ background: l.color }}
            >
              {l.name}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
          Where these two pass each other. The break is drawn on the upper line only.
        </p>
      </div>

      <Slider
        label="Gap length"
        value={o.length ?? project.style.casingLength}
        min={0}
        max={16}
        step={0.5}
        onChange={(v) => setOverride(crossingKey, { length: v })}
      />
      <Slider
        label="Gap height"
        value={o.height ?? project.style.casingHeight}
        min={0}
        max={16}
        step={0.5}
        onChange={(v) => setOverride(crossingKey, { height: v })}
      />

      <div className="space-y-1.5 border-t border-slate-200 pt-3">
        <Toggle
          label="Send the other line over the top"
          checked={Boolean(o.flip)}
          onChange={(v) => setOverride(crossingKey, { flip: v })}
        />
        <Toggle
          label="No break here"
          hint="Let the two simply overlap"
          checked={Boolean(o.off)}
          onChange={(v) => setOverride(crossingKey, { off: v })}
        />
      </div>

      {Object.keys(o).length > 0 && (
        <div className="border-t border-slate-200 pt-3">
          <Button className="w-full" onClick={() => clearOverride(crossingKey)}>
            Back to the map default
          </Button>
        </div>
      )}
    </div>
  )
}
