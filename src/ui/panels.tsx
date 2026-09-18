import { useMemo, useState } from 'react'

import { applyCsv, linesToCsv, parseCsv, stationsToCsv, type ImportReport } from '../domain/csv'
import { LINE_PALETTE, STYLE_PRESETS, modeById } from '../domain/defaults'
import { segmentKey, splitSegmentKey, type Space } from '../domain/network'
import type {
  PlacementKind,
  AssetId,
  BadgeShape,
  BranchDirection,
  ImageLayer,
  Line,
  LineId,
  PlacementId,
  SnapKind,
  StationId,
  StationStatus,
  TerrainFill,
  TerrainId,
  TerrainKind,
} from '../domain/types'
import { summarizeIssues, validateProject } from '../domain/validate'
import { downloadText, importAssetFiles, importImageFiles, pickFiles } from '../persistence/files'
import { requestFit } from '../render/MapView'
import { networkOf, useEditor, type Tool } from '../store/editor-store'
import { contentBounds } from '../export/exporters'
import { BUILTIN_BADGES, useBlobUrls } from '../render/layers'
import {
  ToolDock,
  MODES,
  MenuItem,
  OverflowMenu,
  PanelHeader,
  ToolTile,
  type Density,
  type Mode,
  type Theme,
} from './shell'
import {
  IconBend,
  IconBranch,
  IconCheck,
  IconCursor,
  IconDiagram,
  IconExport,
  IconEye,
  IconEyeOff,
  IconGlobe,
  IconHand,
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
  { id: 'zone', label: 'Fare zone' },
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

/**
 * The tools, floating over the canvas.
 *
 * Moved out of the top bar, where six labelled buttons occupied a 64px band across the
 * full width and left no room for Export at common laptop widths. Vertical and icon-only
 * costs a sliver of canvas, and it scales: terrain kinds, asset placing and pass-through
 * marking all need a home, and a labelled horizontal row had none to give.
 */
export function ToolPalette() {
  const project = useEditor((s) => s.project)
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const setSnap = useEditor((s) => s.setSnap)
  const snapSuspended = useEditor((s) => s.snapSuspended)
  const [snapOpen, setSnapOpen] = useState(false)
  if (!project) return null

  const activeSnaps = SNAPS.filter((s) => project.snap[s.id]).length

  return (
    <ToolDock>
      {TOOLS.map((t, i) => (
        <ToolTile
          key={t.id}
          active={tool === t.id}
          label={t.label}
          shortcut={['V', 'S', 'L', 'T', 'B', 'H'][i]}
          onClick={() => setTool(t.id)}
        >
          {t.icon}
        </ToolTile>
      ))}

      <div className="my-0.5 h-px bg-slate-200" />

      <div className="relative">
        <ToolTile
          active={snapOpen}
          label={`Snapping — ${activeSnaps} of ${SNAPS.length} on${snapSuspended ? ', held off' : ''}`}
          shortcut="hold Alt to suspend"
          onClick={() => setSnapOpen((v) => !v)}
        >
          <span className={snapSuspended ? 'opacity-40' : undefined}>
            <IconMagnet size={17} />
          </span>
        </ToolTile>
        {snapOpen && (
          <div className="absolute left-11 top-0 z-20 w-64 rounded-xl border border-slate-200 bg-white p-2.5 shadow-xl">
            <SectionLabel>Snapping</SectionLabel>
            <div className="mt-1.5 space-y-1">
              {SNAPS.map((sn) => (
                <Toggle
                  key={sn.id}
                  label={sn.label}
                  hint={sn.hint}
                  checked={project.snap[sn.id]}
                  onChange={(v) => setSnap({ [sn.id]: v })}
                />
              ))}
            </div>
            <p className="mt-2 border-t border-slate-200 pt-2 text-[11px] text-slate-500">
              Hold <Kbd>Alt</Kbd> to suspend all of it for one move.
            </p>
          </div>
        )}
      </div>
    </ToolDock>
  )
}

export function Toolbar({
  onExport,
  onHelp,
  theme,
  density,
  onTheme,
  onDensity,
}: {
  onExport: () => void
  onHelp: () => void
  theme: Theme
  density: Density
  onTheme: (t: Theme) => void
  onDensity: (d: Density) => void
}) {
  const project = useEditor((s) => s.project)
  const space = useEditor((s) => s.space)
  const tool = useEditor((s) => s.tool)
  const dirty = useEditor((s) => s.dirty)
  const terrainKind = useEditor((s) => s.terrainKind)
  const setSpace = useEditor((s) => s.setSpace)
  const setTerrainKind = useEditor((s) => s.setTerrainKind)
  const renameProject = useEditor((s) => s.renameProject)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const past = useEditor((s) => s.past)
  const future = useEditor((s) => s.future)

  if (!project) return null

  return (
    <header className="z-30 shrink-0 border-b border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {/*
          The title grows into whatever room is left rather than sitting at a fixed
          160px, where "Aldbury — example network" was clipped to "example n".
        */}
        <input
          value={project.name}
          onChange={(e) => renameProject(e.target.value)}
          className="min-w-24 flex-1 rounded-md border border-transparent px-2 py-1 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-slate-900 focus:outline-none"
          aria-label="Project name"
          title={project.name}
        />

        <Segmented
          value={space}
          onChange={(v) => setSpace(v as Space)}
          options={[
            { value: 'geo', label: 'Map', icon: <IconGlobe size={14} />, hint: 'The real layout, over your screenshots (G)' },
            { value: 'schematic', label: 'Diagram', icon: <IconDiagram size={14} />, hint: 'The tidied-up transit diagram (G)' },
          ]}
        />

        <div className="flex shrink-0 items-center gap-0.5">
          <HealthChip />
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

          <OverflowMenu label="More">
            {(close) => (
              <>
                <MenuItem hint="F" onClick={() => { requestFit('all'); close() }}>
                  Zoom to fit
                </MenuItem>
                <MenuItem hint="?" onClick={() => { onHelp(); close() }}>
                  Keyboard shortcuts
                </MenuItem>
                <div className="my-1 border-t border-slate-200" />
                <MenuItem
                  onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
                >
                  {theme === 'dark' ? 'Light editor' : 'Dark editor'}
                </MenuItem>
                <MenuItem
                  onClick={() => onDensity(density === 'compact' ? 'comfortable' : 'compact')}
                >
                  {density === 'compact' ? 'Comfortable spacing' : 'Compact spacing'}
                </MenuItem>
              </>
            )}
          </OverflowMenu>

          <span
            className="mx-0.5 w-10 shrink-0 text-right font-mono text-[10px] text-slate-400"
            title={dirty ? 'Saving to this browser' : 'Saved to this browser'}
          >
            {dirty ? 'saving' : 'saved'}
          </span>

          {/* Never optional, never collapsed, never clipped. */}
          <Button variant="primary" size="md" onClick={onExport}>
            <IconExport size={15} />
            Export
          </Button>
        </div>
      </div>

      {tool === 'terrain' && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50 px-3 py-1.5">
          <SectionLabel>Tracing</SectionLabel>
          <div className="flex flex-wrap gap-1">
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


/**
 * The list for whatever mode the rail is on.
 *
 * Replaces a five-tab strip that was already overlapping its own labels at 1280px and
 * had no room for the modes this release adds. The rail owns the switching now; this
 * just renders the right list and a heading that says where you are.
 */
export function Browser({ mode }: { mode: Mode }) {
  // Lines and stops are two views of one subject, so they share a mode rather than
  // competing for a slot on the rail.
  const [netView, setNetView] = useState<'lines' | 'stops'>('lines')
  const project = useEditor((s) => s.project)
  if (!project) return null
  const meta = MODES.find((m) => m.id === mode)!

  return (
    <>
      <PanelHeader title={meta.label}>
        {mode === 'network' && (
          <Segmented
            value={netView}
            onChange={(v) => setNetView(v as 'lines' | 'stops')}
            options={[
              { value: 'lines', label: 'Lines' },
              { value: 'stops', label: 'Stops' },
            ]}
          />
        )}
      </PanelHeader>
      <div className="tds-scroll flex-1 overflow-y-auto p-3">
        {mode === 'network' && (netView === 'lines' ? <LinesTab /> : <StationsTab />)}
        {mode === 'terrain' && <LayersTab />}
        {mode === 'images' && <ImagesTab />}
        {mode === 'assets' && <AssetsTab />}
        {mode === 'route' && <RouteTab />}
        {mode === 'data' && <DataTab />}
        {mode === 'checks' && <ChecksTab />}
      </div>
    </>
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
                      {/*
                        Always visible, never hover-only. The panel below this list
                        states that the order decides which line sits on which side of
                        a shared corridor -- so hiding the only control that changes it
                        until the pointer happens to land on the row was the wrong
                        trade the whole time.
                      */}
                      <span className="tds-row-actions flex shrink-0 items-center">
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
  zone: 'Fare zone',
  waterway: 'River',
  water: 'Water',
  green: 'Park',
  builtup: 'Built-up',
  boundary: 'Boundary',
  label: 'Text',
}

/** Terrain: rivers, parks, zones and free text. */
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

  return (
    <div className="space-y-4">
      <div className="space-y-2">
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

/**
 * The screenshots being traced.
 *
 * Split out of the terrain panel, which used to hold both. They are different jobs --
 * one is the source material, the other is what you draw over it -- and sharing a tab
 * meant whichever you wanted was half a scroll away from whichever you did not.
 */
function ImagesTab() {
  const project = useEditor((s) => s.project)!
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
    </div>
  )
}

/**
 * The asset library.
 *
 * Its whole reason for existing is that the source art is already in the project. A
 * landmark, an airport glyph or a faction crest can be cropped out of an imported
 * screenshot and reused, instead of being approximated with one of five built-in
 * shapes.
 */
function AssetsTab() {
  const project = useEditor((s) => s.project)!
  const space = useEditor((s) => s.space)
  const addAsset = useEditor((s) => s.addAsset)
  const renameAsset = useEditor((s) => s.renameAsset)
  const deleteAsset = useEditor((s) => s.deleteAsset)
  const addPlacement = useEditor((s) => s.addPlacement)
  const deletePlacements = useEditor((s) => s.deletePlacements)
  const select = useEditor((s) => s.select)
  const selection = useEditor((s) => s.selection)
  const [busy, setBusy] = useState(false)
  const cropping = useEditor((s) => s.cropping)
  const setCropping = useEditor((s) => s.setCropping)

  const urls = useBlobUrls(project.assets.map((a) => a.blobKey))

  const doImport = async () => {
    const files = await pickFiles('image/*', true)
    if (files.length === 0) return
    setBusy(true)
    try {
      for (const a of await importAssetFiles(files)) addAsset(a)
    } finally {
      setBusy(false)
    }
  }

  // Dropped at the middle of nowhere in particular; the map is panned, so a fixed
  // origin would often land off-screen. Centre of the current content is close enough
  // and always reachable.
  /**
   * The knottiest station on the map, which is the one an inset is almost always about.
   * Starting a callout on the busiest interchange means the first thing you see is the
   * thing worth enlarging, rather than an empty box asking which stop you meant.
   */
  const busiest = useMemo(() => {
    const net = networkOf(project)
    let best: StationId | null = null
    let most = 0
    for (const [id, lines] of net.linesAtStation) {
      if (lines.length > most) {
        most = lines.length
        best = id
      }
    }
    return best
  }, [project])

  const dropAt = () => {
    const b = contentBounds(project, space, 0)
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  }

  const FURNITURE = [
    { kind: 'legend', label: 'Legend', hint: 'Derived from the lines, so it cannot go stale' },
    { kind: 'titleBlock', label: 'Title block', hint: 'Name and a count of what is on the map' },
    { kind: 'northArrow', label: 'North arrow', hint: 'For the geographic view' },
    { kind: 'scaleBar', label: 'Scale bar', hint: 'Two bands with end labels' },
    { kind: 'frame', label: 'Frame', hint: 'A double border around the whole poster' },
    {
      kind: 'inset',
      label: 'Interchange inset',
      hint: 'A magnified callout of one knot of lines, as the London map does',
    },
  ] as const

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-1">
          <SectionLabel>Symbols and markers</SectionLabel>
          <div className="flex gap-1">
            <Button
              variant={cropping ? 'primary' : 'ghost'}
              onClick={() => setCropping(!cropping)}
              disabled={project.images.length === 0}
              title={
                project.images.length === 0
                  ? 'Import a screenshot first'
                  : 'Drag a box over the map view to cut a symbol out of it'
              }
            >
              {cropping ? 'Drag a box…' : 'Crop'}
            </Button>
            <Button onClick={doImport} disabled={busy}>
              <IconPlus size={13} />
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>

        {cropping && (
          <p className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-700">
            Switch to the <strong>Map</strong> view and drag a box around what you want.
            It is cut from the screenshots underneath, so it comes out whole even across
            a seam between two stitched tiles.
          </p>
        )}

        {project.assets.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-slate-400">
            Nothing here yet. Add an image to use it as a station symbol or drop it on the
            map as a marker.
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2">
            {project.assets.map((a) => (
              <li key={a.id} className="tds-row rounded-xl border border-slate-200 p-1.5">
                <div className="flex h-12 items-center justify-center overflow-hidden rounded-lg bg-slate-50">
                  {urls[a.blobKey] ? (
                    <img src={urls[a.blobKey]} alt={a.name} className="max-h-11 max-w-full" />
                  ) : (
                    <span className="text-[10px] text-slate-400">…</span>
                  )}
                </div>
                <input
                  value={a.name}
                  onChange={(e) => renameAsset(a.id, e.target.value)}
                  className="mt-1 w-full rounded border border-transparent px-1 text-[11px] text-slate-700 hover:border-slate-200 focus:border-slate-900 focus:outline-none"
                  aria-label="Asset name"
                />
                <div className="tds-row-actions mt-1 flex justify-between">
                  <button
                    onClick={() => addPlacement({ kind: 'asset', assetId: a.id }, dropAt(), space)}
                    className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  >
                    Place
                  </button>
                  <IconButton label="Delete asset" variant="danger" onClick={() => deleteAsset(a.id)}>
                    <IconTrash size={12} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-3">
        <SectionLabel>Map furniture</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {FURNITURE.map((f) => (
            <button
              key={f.kind}
              disabled={f.kind === 'inset' && busiest === null}
              onClick={() =>
                addPlacement(
                  f.kind === 'inset'
                    ? { kind: 'inset', station: busiest!, radius: 150, zoom: 2.2 }
                    : { kind: f.kind },
                  dropAt(),
                  space,
                )
              }
              title={f.hint}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-left text-[11.5px] font-medium text-slate-700 hover:border-slate-900 hover:text-slate-900"
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {project.placements.length > 0 && (
        <div className="space-y-2 border-t border-slate-200 pt-3">
          <SectionLabel>On the map</SectionLabel>
          <ul className="space-y-1">
            {project.placements.map((pl) => {
              const name =
                pl.what.kind === 'asset'
                  ? (project.assets.find((a) => pl.what.kind === 'asset' && a.id === pl.what.assetId)
                      ?.name ?? 'Marker')
                  : FURNITURE.find((f) => f.kind === pl.what.kind)?.label ?? pl.what.kind
              const sel = selection.placements.includes(pl.id)
              return (
                <li
                  key={pl.id}
                  className={`tds-row flex items-center gap-1 rounded-lg px-2 py-1 ${sel ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                >
                  <button
                    onClick={() => select({ placements: [pl.id] })}
                    className="flex-1 truncate text-left text-[12px] text-slate-700"
                  >
                    {name}
                  </button>
                  <div className="tds-row-actions flex">
                    <IconButton
                      label="Delete"
                      variant="danger"
                      onClick={() => deletePlacements([pl.id])}
                    >
                      <IconTrash size={12} />
                    </IconButton>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Everything the validator found, as a list you can click through.
 *
 * The checker already produced structured issues with titles; they were only ever
 * summarised as a count in the toolbar, so the one thing you wanted -- to be taken to
 * the offending object -- was the one thing it would not do.
 */
function ChecksTab() {
  const project = useEditor((s) => s.project)!
  const select = useEditor((s) => s.select)
  const network = networkOf(project)
  const issues = validateProject(project, network)
  void network

  if (issues.length === 0) {
    return (
      <EmptyState
        title="Nothing looks wrong"
        body="Unnamed stops, duplicate names, lines with one stop and stations sitting on top of each other would all show up here."
      />
    )
  }

  const TONE: Record<string, string> = {
    error: 'border-red-200 bg-red-50 text-red-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-slate-200 bg-slate-50 text-slate-700',
  }

  return (
    <ul className="space-y-1.5">
      {issues.map((issue, i) => (
        <li key={i}>
          <button
            onClick={() => {
              if (issue.stationIds?.length) select({ stations: issue.stationIds })
              else if (issue.lineIds?.length) select({ lines: issue.lineIds })
            }}
            className={`w-full rounded-xl border px-2.5 py-2 text-left ${TONE[issue.severity] ?? TONE.info}`}
          >
            <span className="block text-[12px] font-semibold">{issue.title}</span>
            {issue.detail && (
              <span className="mt-0.5 block text-[11px] leading-relaxed opacity-80">
                {issue.detail}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
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

  const crossingKeys = selection.crossings
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

  const terrain =
    selection.terrain.length === 1
      ? project.terrain.find((t) => t.id === selection.terrain[0])
      : undefined
  const placement =
    selection.placements.length === 1
      ? project.placements.find((pl) => pl.id === selection.placements[0])
      : undefined

  // No wrapper of its own any more: the resizable panel owns the width and the
  // scrolling. This used to be a second fixed-width aside nested inside the first.
  return (
    <>
      {crossingKeys.length > 0 ? (
        <CrossingInspector keys={crossingKeys} />
      ) : transfer ? (
        <TransferInspector id={transfer.id} />
      ) : station ? (
        <StationInspector id={station.id} />
      ) : line ? (
        <LineInspector line={line} />
      ) : terrain ? (
        <TerrainInspector id={terrain.id} />
      ) : placement ? (
        <PlacementInspector id={placement.id} />
      ) : selection.stations.length > 1 ? (
        <MultiStationInspector ids={selection.stations} />
      ) : (
        <NothingSelected />
      )}
    </>
  )
}

/** A traced shape: how it is filled, the rings cut out of it, and free text styling. */
function TerrainInspector({ id }: { id: TerrainId }) {
  const project = useEditor((s) => s.project)!
  const assignZonesFrom = useEditor((s) => s.assignZonesFrom)
  const [zoned, setZoned] = useState<number | null>(null)
  const space = useEditor((s) => s.space)
  const updateTerrain = useEditor((s) => s.updateTerrain)
  const addTerrainHole = useEditor((s) => s.addTerrainHole)
  const deleteTerrain = useEditor((s) => s.deleteTerrain)
  const t = project.terrain.find((x) => x.id === id)
  if (!t) return null

  const text = t.text ?? {}
  const patchText = (patch: Partial<NonNullable<typeof t.text>>) =>
    updateTerrain(id, { text: { ...text, ...patch } })

  return (
    <div className="space-y-3">
      <SectionLabel>{TERRAIN_LABEL[t.kind] ?? 'Shape'}</SectionLabel>

      <input
        value={t.name}
        onChange={(e) => updateTerrain(id, { name: e.target.value })}
        placeholder={t.kind === 'label' ? 'The text to show' : 'Name this shape'}
        className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm font-medium focus:border-slate-900 focus:outline-none"
      />

      {t.kind === 'zone' && (
        <>
          <Field label="Zone" hint="Stations carrying this zone name belong to this band.">
            <input
              value={t.zone ?? ''}
              onChange={(e) => updateTerrain(id, { zone: e.target.value || undefined })}
              placeholder="e.g. 1"
              className={inputClass}
            />
          </Field>
          {/*
            The band already knows which stops are inside it. Typing that out station by
            station is work the shape can do, and work that goes stale the moment the
            map moves.
          */}
          <Button
            className="w-full"
            onClick={() => {
              const n = assignZonesFrom([id])
              setZoned(n)
            }}
          >
            Give the stops inside this band its zone
          </Button>
          {zoned !== null && (
            <p className="text-[11px] leading-relaxed text-slate-500">
              {zoned === 0
                ? 'No stops fell inside it. Give the band a zone name and check the shape is closed.'
                : `${zoned} station${zoned === 1 ? '' : 's'} updated.`}
            </p>
          )}
        </>
      )}

      {t.kind === 'label' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Size">
              <input
                type="number"
                value={text.size ?? Math.round(project.style.fontSize * 1.4)}
                onChange={(e) => patchText({ size: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>
            <Field label="Angle">
              <input
                type="number"
                value={text.angle ?? 0}
                onChange={(e) => patchText({ angle: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={text.color ?? project.style.foreground}
              onChange={(e) => patchText({ color: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-slate-300 bg-transparent"
              aria-label="Text colour"
            />
            <Segmented
              value={text.align ?? 'middle'}
              onChange={(v) => patchText({ align: v as 'start' | 'middle' | 'end' })}
              options={[
                { value: 'start', label: 'Left' },
                { value: 'middle', label: 'Centre' },
                { value: 'end', label: 'Right' },
              ]}
            />
          </div>
          <div className="flex gap-2">
            <Toggle
              label="Bold"
              checked={(text.weight ?? 400) >= 600}
              onChange={(v) => patchText({ weight: v ? 700 : 400 })}
            />
            <Toggle
              label="Italic"
              checked={!!text.italic}
              onChange={(v) => patchText({ italic: v })}
            />
          </div>
          <Slider
            label="Opacity"
            hint="Annotations usually sit back from the network."
            value={Math.round((text.opacity ?? 0.45) * 100)}
            min={10}
            max={100}
            suffix="%"
            onChange={(v) => patchText({ opacity: v / 100 })}
          />
        </>
      ) : (
        <>
          <Field label="Fill" hint="Hatching reads as parkland; flat colour reads as water.">
            <Segmented
              value={t.fill}
              onChange={(v) => updateTerrain(id, { fill: v as TerrainFill })}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'hatch', label: 'Hatch' },
                { value: 'stipple', label: 'Stipple' },
                { value: 'none', label: 'Outline' },
              ]}
            />
          </Field>

          {t.closed && (
            <Field
              label="Holes"
              hint="A ring cut out of this shape — an island in a lake, a courtyard in a park."
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[12px] text-slate-600">
                  {t.holes.length === 0 ? 'None' : `${t.holes.length} cut out`}
                </span>
                <Button onClick={() => addTerrainHole(id, space)}>Add</Button>
                {t.holes.length > 0 && (
                  <Button onClick={() => updateTerrain(id, { holes: [] })}>Clear</Button>
                )}
              </div>
            </Field>
          )}
        </>
      )}

      <button
        onClick={() => deleteTerrain([id])}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[12.5px] font-medium text-red-600 hover:bg-red-50"
      >
        <IconTrash size={13} />
        Delete shape
      </button>
    </div>
  )
}

/** A piece of map furniture: a marker, the legend, an arrow, a frame. */
function PlacementInspector({ id }: { id: PlacementId }) {
  const project = useEditor((s) => s.project)!
  const updatePlacement = useEditor((s) => s.updatePlacement)
  const deletePlacements = useEditor((s) => s.deletePlacements)
  const pl = project.placements.find((x) => x.id === id)
  if (!pl) return null

  const name =
    pl.what.kind === 'asset'
      ? (project.assets.find((a) => pl.what.kind === 'asset' && a.id === pl.what.assetId)?.name ??
        'Marker')
      : pl.what.kind

  return (
    <div className="space-y-3">
      <SectionLabel>{name}</SectionLabel>

      {pl.what.kind !== 'asset' && (
        <Field label="Caption">
          <input
            value={pl.label ?? ''}
            onChange={(e) => updatePlacement(id, { label: e.target.value || undefined })}
            placeholder="Leave blank for the default"
            className={inputClass}
          />
        </Field>
      )}

      {pl.what.kind === 'inset' && (
        <>
          <Field label="Station" hint="The inset follows this stop wherever it moves.">
            <select
              value={pl.what.station}
              onChange={(e) =>
                updatePlacement(id, {
                  what: { ...(pl.what as Extract<PlacementKind, { kind: 'inset' }>), station: e.target.value as StationId },
                })
              }
              className={inputClass}
            >
              {[...project.stations]
                .filter((st) => st.name)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
            </select>
          </Field>
          <Slider
            label="How much it covers"
            value={pl.what.radius}
            min={40}
            max={400}
            step={10}
            onChange={(v) =>
              updatePlacement(id, {
                what: { ...(pl.what as Extract<PlacementKind, { kind: 'inset' }>), radius: v },
              })
            }
          />
          <Slider
            label="Magnification"
            value={Math.round(pl.what.zoom * 100)}
            min={120}
            max={500}
            step={10}
            suffix="%"
            onChange={(v) =>
              updatePlacement(id, {
                what: { ...(pl.what as Extract<PlacementKind, { kind: 'inset' }>), zoom: v / 100 },
              })
            }
          />
        </>
      )}

      <Slider
        label="Size"
        value={Math.round(pl.scale * 100)}
        min={20}
        max={400}
        suffix="%"
        onChange={(v) => updatePlacement(id, { scale: v / 100 })}
      />
      <Slider
        label="Rotation"
        value={pl.angle}
        min={-180}
        max={180}
        suffix="°"
        onChange={(v) => updatePlacement(id, { angle: v })}
      />
      <Slider
        label="Opacity"
        value={Math.round(pl.opacity * 100)}
        min={10}
        max={100}
        suffix="%"
        onChange={(v) => updatePlacement(id, { opacity: v / 100 })}
      />
      <Toggle
        label="Locked"
        hint="Stops it being dragged by accident while you work around it."
        checked={pl.locked}
        onChange={(v) => updatePlacement(id, { locked: v })}
      />

      <button
        onClick={() => deletePlacements([id])}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[12.5px] font-medium text-red-600 hover:bg-red-50"
      >
        <IconTrash size={13} />
        Remove from the map
      </button>
    </div>
  )
}

/**
 * What the inspector says when nothing is chosen.
 *
 * It used to carry the whole map-style panel too, which meant restyling the map
 * required deselecting first -- the settings vanished the instant you clicked
 * anything. Style now lives in its own always-present panel below; this is just the
 * prompt.
 */
function NothingSelected() {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-3">
      <p className="text-[12px] font-semibold text-slate-800">Nothing selected</p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-slate-500">
        Click a station or a line on the map to edit it. Drag on empty space to select
        several at once.
      </p>
    </div>
  )
}

/**
 * How the map looks. Always visible, whatever is selected.
 */
export function MapStylePanel() {
  const project = useEditor((s) => s.project)
  const setStyle = useEditor((s) => s.setStyle)
  const setView = useEditor((s) => s.setView)
  const applyPreset = useEditor((s) => s.applyStylePreset)
  const space = useEditor((s) => s.space)
  void space

  // The panel mounts with the frame, which can be a tick ahead of the project landing
  // in the store. Asserting non-null here took the whole editor down with it.
  if (!project) return null

  return (
    <div className="space-y-3">
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

      <Section title="Route bullets">
        <Field
          label="Shape"
          hint="Networks are recognised by this as much as by their colours."
        >
          <select
            value={project.style.badgeShape}
            onChange={(e) => setStyle({ badgeShape: e.target.value as BadgeShape })}
            className={inputClass}
          >
            <option value="roundel">Roundel — a bar across a ring</option>
            <option value="circle">Circle</option>
            <option value="square">Square</option>
            <option value="diamond">Diamond</option>
            <option value="hex">Hexagon</option>
          </select>
        </Field>
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
          label="Click target"
          hint="How close the pointer has to get to a stop. Larger is easier to hit; the drawn dot does not change."
          value={project.style.hitRadius}
          min={8}
          max={32}
          onChange={(v) => setStyle({ hitRadius: v })}
        />
        <Slider
          label="Second name size"
          hint="Relative to the main name."
          value={Math.round(project.style.secondaryNameScale * 100)}
          min={50}
          max={100}
          suffix="%"
          onChange={(v) => setStyle({ secondaryNameScale: v / 100 })}
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


/**
 * Which track each line runs on, where several share a corridor.
 *
 * The model has had `corridorOrder` since the beginning and it was all but unusable:
 * reachable only by selecting a LINE, buried at the foot of that inspector, and listed
 * one row per SEGMENT, so putting the red line above the blue one along a twelve-segment
 * run meant twelve trips through a panel, each identified by a pair of station names.
 *
 * Here it is where the question gets asked — at the place you are looking at — and one
 * move applies to the whole run the two lines share.
 */
function TrackOrder({ id }: { id: StationId }) {
  const project = useEditor((s) => s.project)!
  const move = useEditor((s) => s.moveLineAcrossCorridor)
  const network = networkOf(project)

  const groups = useMemo(() => {
    const out: { key: string; toward: string; lines: LineId[] }[] = []
    const seen = new Set<string>()
    for (const n of network.neighbours.get(id) ?? []) {
      const key = segmentKey(id, n)
      const lines = network.corridors.get(key) ?? []
      if (lines.length < 2) continue
      // A station in the middle of a bundle has the same lines on both sides of it.
      // Listing that twice asks the same question twice and invites two answers.
      const signature = lines.join('|')
      if (seen.has(signature)) continue
      seen.add(signature)
      out.push({
        key,
        toward: project.stations.find((s) => s.id === n)?.name || 'the next stop',
        lines,
      })
    }
    return out
  }, [network, project.stations, id])

  if (groups.length === 0) return null

  return (
    <Section title={`Tracks through here (${groups.length})`} defaultOpen>
      <p className="text-[11px] leading-relaxed text-slate-500">
        The order across the corridor, first row on one side. Moving a line moves it
        everywhere the two stay side by side, not just here.
      </p>
      {groups.map((g) => (
        <div key={g.key} className="rounded-lg border border-slate-200 p-2">
          <p className="mb-1 truncate text-[10.5px] text-slate-500">towards {g.toward}</p>
          <ul className="space-y-0.5">
            {g.lines.map((lineId, i) => {
              const l = project.lines.find((x) => x.id === lineId)
              if (!l) return null
              return (
                <li key={lineId} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10"
                    style={{ background: l.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-700">
                    {l.name}
                  </span>
                  <IconButton
                    label="Move towards the first side"
                    disabled={i === 0}
                    onClick={() => move(g.key, lineId, -1)}
                  >
                    <span className="text-[11px]">↑</span>
                  </IconButton>
                  <IconButton
                    label="Move towards the other side"
                    disabled={i === g.lines.length - 1}
                    onClick={() => move(g.key, lineId, 1)}
                  >
                    <span className="text-[11px]">↓</span>
                  </IconButton>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </Section>
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
  const updateStation = useEditor((s) => s.updateStation)
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

      {/*
        A second name, set smaller beneath the first. Half the world's networks need
        one -- Tokyo, Seoul, Brussels, Montreal -- and a single name field cannot
        carry both scripts.
      */}
      <input
        value={station.nameSecondary ?? ''}
        onChange={(e) => updateStation(id, { nameSecondary: e.target.value || undefined })}
        placeholder="Second name (optional)"
        className={inputClass}
        aria-label="Second name"
      />

      <div className="grid grid-cols-2 gap-2">
        <Field label="Fare zone">
          <input
            value={station.zone ?? ''}
            onChange={(e) => updateStation(id, { zone: e.target.value || undefined })}
            placeholder="e.g. 1"
            className={inputClass}
          />
        </Field>
        <Field label="Status">
          <select
            value={station.status}
            onChange={(e) => updateStation(id, { status: e.target.value as StationStatus })}
            className={inputClass}
          >
            <option value="open">Open</option>
            <option value="construction">Under construction</option>
            <option value="planned">Planned</option>
          </select>
        </Field>
      </div>

      <Field label="Marks" hint="Shown beside the name on the finished map.">
        <div className="flex flex-wrap gap-1">
          {BUILTIN_BADGES.map((b) => {
            const on = station.badges.includes(b.id)
            return (
              <button
                key={b.id}
                onClick={() =>
                  updateStation(id, {
                    badges: on
                      ? station.badges.filter((x) => x !== b.id)
                      : [...station.badges, b.id],
                  })
                }
                aria-pressed={on}
                title={b.name}
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
                  on
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 text-slate-600 hover:border-slate-400'
                }`}
              >
                {b.name}
              </button>
            )
          })}
        </div>
      </Field>

      {project.assets.length > 0 && (
        <Field label="Symbol" hint="Use a mark from your library instead of the derived shape.">
          <select
            value={station.symbol.kind === 'asset' ? station.symbol.assetId : 'auto'}
            onChange={(e) =>
              updateStation(id, {
                symbol:
                  e.target.value === 'auto'
                    ? { kind: 'auto' }
                    : { kind: 'asset', assetId: e.target.value as AssetId, scale: 1 },
              })
            }
            className={inputClass}
          >
            <option value="auto">Derived from the lines</option>
            {project.assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}

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

      <TrackOrder id={id} />

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

/**
 * The calling pattern of the last branch copied, kept outside React so it survives the
 * inspector being torn down and rebuilt — which is the whole point: the useful paste is
 * onto a DIFFERENT line.
 */
let copiedCalls: { name: string; calls: StationId[] } | null = null

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
  const updateBranch = useEditor((s) => s.updateBranch)
  const setStopCalls = useEditor((s) => s.setStopCalls)
  const setCallingPattern = useEditor((s) => s.setCallingPattern)
  const [, bumpClipboard] = useState(0)
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
            <div className="mb-1.5 grid grid-cols-2 gap-1.5">
              <Segmented
                value={b.direction}
                onChange={(v) => updateBranch(line.id, b.id, { direction: v as BranchDirection })}
                options={[
                  { value: 'both', label: 'Both ways' },
                  { value: 'forward', label: 'One way' },
                ]}
              />
              <input
                value={b.service ?? ''}
                onChange={(e) => updateBranch(line.id, b.id, { service: e.target.value || undefined })}
                placeholder="When it runs"
                title="Free text, e.g. Nights or Peak only. Shown, never interpreted."
                className="rounded-lg border border-slate-300 px-2 py-1 text-[11.5px] focus:border-slate-900 focus:outline-none"
              />
            </div>

            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="text-[11px] text-slate-500">Branch colour</span>
              <input
                type="color"
                value={b.color ?? line.color}
                onChange={(e) => updateBranch(line.id, b.id, { color: e.target.value })}
                className="h-5 w-8 cursor-pointer rounded border border-slate-300 bg-transparent"
                aria-label="Branch colour"
              />
              {b.color && (
                <button
                  onClick={() => updateBranch(line.id, b.id, { color: undefined })}
                  className="text-[11px] text-slate-500 underline hover:text-slate-900"
                >
                  match the line
                </button>
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
                    <button
                      onClick={() => setStopCalls(line.id, b.id, sid, false)}
                      title="This line passes through without stopping"
                      className="shrink-0 rounded px-1 text-[13px] leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-900"
                    >
                      ●
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

            {b.stops.length > 2 && (
              <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-dashed border-slate-200 pt-1.5">
                <span className="mr-0.5 text-[11px] text-slate-500">Calls at</span>
                <button
                  onClick={() => setCallingPattern(line.id, b.id, 'all')}
                  className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  every stop
                </button>
                <button
                  onClick={() => setCallingPattern(line.id, b.id, 'alternate-a')}
                  title="Chicago skip-stop: this one and its partner between them serve everything"
                  className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  every other
                </button>
                <button
                  onClick={() => setCallingPattern(line.id, b.id, 'alternate-b')}
                  title="The other half of the skip-stop pair"
                  className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  the others
                </button>
                <span className="mx-0.5 text-slate-300">|</span>
                <button
                  onClick={() => {
                    copiedCalls = { name: b.name || line.name, calls: [...b.stops] }
                    bumpClipboard((n) => n + 1)
                  }}
                  className="rounded px-1 text-[11px] text-slate-500 underline hover:text-slate-900"
                >
                  copy
                </button>
                {copiedCalls && (
                  <button
                    onClick={() =>
                      setCallingPattern(line.id, b.id, { calls: copiedCalls!.calls })
                    }
                    title={`Call at the same stops as ${copiedCalls.name}`}
                    className="rounded px-1 text-[11px] text-slate-500 underline hover:text-slate-900"
                  >
                    paste from {copiedCalls.name}
                  </button>
                )}
              </div>
            )}

            {b.passes.length > 0 && (
              <div className="mt-2 border-t border-dashed border-slate-200 pt-1.5">
                <span className="text-[11px] font-medium text-slate-500">
                  Passes through without stopping
                </span>
                <ul className="mt-1 space-y-0.5">
                  {b.passes.map((sid) => (
                    <li key={sid} className="group flex items-center gap-1">
                      <span className="w-4 shrink-0 text-right text-[11px] text-slate-300">○</span>
                      <button
                        onClick={() => select({ stations: [sid] })}
                        className="min-w-0 flex-1 truncate text-left text-[11.5px] italic text-slate-500 hover:text-slate-900 hover:underline"
                      >
                        {nameOf(sid)}
                      </button>
                      <button
                        onClick={() => setStopCalls(line.id, b.id, sid, true)}
                        title="Call here instead — it is added at the end of the run"
                        className="shrink-0 rounded px-1 text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-900"
                      >
                        call here
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
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

/**
 * Where this line runs beside others, and in what order.
 *
 * Listed by RUN, not by segment. A pair of lines sharing a dozen segments is one thing
 * to a reader — one pair of parallel tracks — and the old per-segment list turned a
 * single decision into a dozen identical ones, then capped itself at six of them.
 */
export function CorridorInspector({ lineId }: { lineId: LineId }) {
  const project = useEditor((s) => s.project)!
  const move = useEditor((s) => s.moveLineAcrossCorridor)
  const network = networkOf(project)

  const runs = useMemo(() => {
    const mine = [...network.corridors.entries()]
      .filter(([, ids]) => ids.length > 1 && ids.includes(lineId))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const shape = new Map(mine)

    // A run is a connected stretch carrying exactly the same set of lines. Where the
    // set changes — one joins, one leaves — the ordering question changes with it.
    const byStation = new Map<string, string[]>()
    for (const [key, ids] of mine) {
      for (const end of splitSegmentKey(key)) {
        const bucket = `${end}\u0000${ids.join('|')}`
        const list = byStation.get(bucket)
        if (list) list.push(key)
        else byStation.set(bucket, [key])
      }
    }

    const seen = new Set<string>()
    const out: { key: string; lines: LineId[]; group: string[] }[] = []
    for (const [key, ids] of mine) {
      if (seen.has(key)) continue
      seen.add(key)
      const group = [key]
      const queue = [key]
      while (queue.length > 0) {
        const cur = queue.shift()!
        for (const end of splitSegmentKey(cur)) {
          for (const next of byStation.get(`${end}\u0000${ids.join('|')}`) ?? []) {
            if (seen.has(next) || shape.get(next)?.join('|') !== ids.join('|')) continue
            seen.add(next)
            group.push(next)
            queue.push(next)
          }
        }
      }
      out.push({ key, lines: ids, group })
    }
    return out.sort((a, b) => b.group.length - a.group.length)
  }, [network, lineId])

  if (runs.length === 0) return null

  const nameOf = (id: string) => project.stations.find((s) => s.id === id)?.name || 'Unnamed'

  /** The two ends of a run: stations its segments touch exactly once. */
  const endsOf = (group: string[]): string => {
    const count = new Map<string, number>()
    for (const key of group) {
      for (const end of splitSegmentKey(key)) count.set(end, (count.get(end) ?? 0) + 1)
    }
    const ends = [...count.entries()].filter(([, n]) => n === 1).map(([id]) => nameOf(id))
    if (ends.length === 2) return `${ends[0]} – ${ends[1]}`
    return `${group.length} segment${group.length === 1 ? '' : 's'}`
  }

  return (
    <Section title={`Runs alongside (${runs.length})`}>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Where lines run together they are drawn side by side. Moving one changes the whole
        stretch they share.
      </p>
      {runs.map((run) => (
        <div key={run.key} className="rounded-lg border border-slate-200 p-2">
          <p className="mb-1 truncate text-[10.5px] text-slate-500">
            {endsOf(run.group)}
            {run.group.length > 1 && ` · ${run.group.length} segments`}
          </p>
          <ul className="space-y-0.5">
            {run.lines.map((id, i) => {
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
                    label="Move towards the first side"
                    disabled={i === 0}
                    onClick={() => move(run.key, id, -1)}
                  >
                    <span className="text-[11px]">↑</span>
                  </IconButton>
                  <IconButton
                    label="Move towards the other side"
                    disabled={i === run.lines.length - 1}
                    onClick={() => move(run.key, id, 1)}
                  >
                    <span className="text-[11px]">↓</span>
                  </IconButton>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
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

/**
 * One overpass, or a row of them.
 *
 * Every crossing has always had its own gap, its own choice of which line goes over and
 * its own off switch — the model carried all four. Reaching them meant hitting a
 * nine-pixel invisible square, so in practice people changed the map-wide sliders and
 * lived with the result. Shift-click adds to the selection, and the two buttons at the
 * foot apply what is set here to every crossing this pair of lines makes, which is
 * usually the honest unit of the decision.
 */
function CrossingInspector({ keys }: { keys: string[] }) {
  const project = useEditor((s) => s.project)!
  const setOverride = useEditor((s) => s.setCrossingOverride)
  const clearOverride = useEditor((s) => s.clearCrossingOverride)
  const select = useEditor((s) => s.select)

  const first = keys[0]
  const o = project.crossings[first] ?? {}
  const many = keys.length > 1

  /** Which two lines meet here is recoverable from the key, which is built out of them. */
  const linesOf = (key: string) =>
    key
      .split('#')[0]
      .split('|')
      .map((half) => half.split('~')[0])
      .map((id) => project.lines.find((l) => l.id === id))
      .filter((l): l is (typeof project.lines)[number] => !!l)

  const lineNames = useMemo(() => linesOf(first), [first, project.lines])

  /** Every crossing anywhere between the same pair of lines. */
  const siblings = useMemo(() => {
    const mine = new Set(lineNames.map((l) => l.id))
    if (mine.size < 2) return []
    const out: string[] = []
    for (const key of Object.keys(project.crossings)) {
      const ids = new Set(linesOf(key).map((l) => l.id))
      if (ids.size === mine.size && [...ids].every((id) => mine.has(id))) out.push(key)
    }
    return out
  }, [lineNames, project.crossings])

  const apply = (patch: Parameters<typeof setOverride>[1], to: string[] = keys) => {
    for (const key of to) setOverride(key, patch)
  }

  return (
    <div className="space-y-3">
      <SectionLabel>{many ? `${keys.length} crossings` : 'Crossing'}</SectionLabel>

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
          {many
            ? 'Changes apply to all of them at once.'
            : 'Where these two pass each other. The break is drawn on the upper line only.'}
        </p>
      </div>

      <Slider
        label="Gap length"
        value={o.length ?? project.style.casingLength}
        min={0}
        max={16}
        step={0.5}
        onChange={(v) => apply({ length: v })}
      />
      <Slider
        label="Gap height"
        value={o.height ?? project.style.casingHeight}
        min={0}
        max={16}
        step={0.5}
        onChange={(v) => apply({ height: v })}
      />

      <div className="space-y-1.5 border-t border-slate-200 pt-3">
        <Toggle
          label="Send the other line over the top"
          checked={Boolean(o.flip)}
          onChange={(v) => apply({ flip: v })}
        />
        <Toggle
          label="No break here"
          hint="Let the two simply overlap"
          checked={Boolean(o.off)}
          onChange={(v) => apply({ off: v })}
        />
      </div>

      {!many && siblings.length > 1 && (
        <div className="space-y-1.5 border-t border-slate-200 pt-3">
          <p className="text-[11px] leading-relaxed text-slate-500">
            These two lines cross each other in {siblings.length} places.
          </p>
          <Button className="w-full" onClick={() => apply(o, siblings)}>
            Use these settings everywhere they cross
          </Button>
          <Button className="w-full" onClick={() => select({ crossings: siblings })}>
            Select all {siblings.length}
          </Button>
        </div>
      )}

      {keys.some((k) => Object.keys(project.crossings[k] ?? {}).length > 0) && (
        <div className="border-t border-slate-200 pt-3">
          <Button
            className="w-full"
            onClick={() => {
              for (const key of keys) clearOverride(key)
            }}
          >
            Back to the map default
          </Button>
        </div>
      )}
    </div>
  )
}
