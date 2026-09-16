/**
 * The editor store.
 *
 * History is patch-based: every mutation goes through `mutate()`, which runs the recipe
 * through Immer's `produceWithPatches` and records the forward and inverse patches.
 * Undo/redo therefore covers every operation — including bulk ones — without any
 * command needing to know it exists.
 *
 * Only `project` is under history. Viewport, selection, active tool and transient
 * guides are UI state and deliberately excluded, so undo never scrolls the canvas or
 * changes what is selected out from under you.
 */

import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer'
import { create } from 'zustand'

import { makeBranch, makeStation, makeTerrain, nextUnusedColor, presetById } from '../domain/defaults'
import { add, dist, octilinearizeRun, simplify, sub } from '../domain/geometry'
import {
  newBranchId,
  newLineId,
  newStationId,
  newTerrainId,
  newTransferId,
} from '../domain/ids'
import {
  buildNetwork,
  segmentKey,
  type Network,
  type Space,
} from '../domain/network'
import { findRoute, type Route } from '../domain/routing'
import type {
  Bend,
  CrossingOverride,
  ModeStyle,
  Branch,
  ImageId,
  ImageLayer,
  Line,
  LineId,
  ModeId,
  Project,
  SnapSettings,
  Station,
  StationId,
  StationLabel,
  StyleSettings,
  Terrain,
  TerrainId,
  TerrainKind,
  TransferId,
  Vec2,
  ViewSettings,
} from '../domain/types'

enablePatches()

// ---------------------------------------------------------------------------
// Derived-network cache
// ---------------------------------------------------------------------------

let netCacheKey: Project | null = null
let netCacheVal: Network | null = null

/**
 * Immer hands back a new `Project` object on every change, so reference identity is a
 * perfect cache key here — the network is rebuilt exactly when something changed.
 */
export function networkOf(project: Project): Network {
  if (netCacheKey === project && netCacheVal) return netCacheVal
  netCacheKey = project
  netCacheVal = buildNetwork(project)
  return netCacheVal
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  coalesceKey?: string
  at: number
}

/** Generous enough to be "unlimited" for hand editing, bounded enough to not leak. */
const HISTORY_LIMIT = 2000

/** Merges into the previous entry if the same gesture continues within this window. */
const COALESCE_WINDOW_MS = 1200

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

export type Tool = 'select' | 'station' | 'line' | 'terrain' | 'bend' | 'pan'

export interface Selection {
  stations: StationId[]
  lines: LineId[]
  terrain: TerrainId[]
  images: ImageId[]
  transfers: TransferId[]
  crossings: string[]
}

export const emptySelection = (): Selection => ({
  stations: [],
  lines: [],
  terrain: [],
  images: [],
  transfers: [],
  crossings: [],
})

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface MutateOptions {
  /** Same key within the coalesce window merges into the previous undo step. */
  coalesceKey?: string
}

interface EditorState {
  project: Project | null
  past: HistoryEntry[]
  future: HistoryEntry[]

  space: Space
  tool: Tool
  selection: Selection
  viewports: Record<Space, Viewport>
  /** Line currently being extended by the line tool. */
  activeLineId: LineId | null
  activeBranchId: string | null
  /** True while Alt is held; suspends snapping without changing the settings. */
  snapSuspended: boolean
  /** Which kind of shape the terrain tool will draw next. */
  terrainKind: TerrainKind
  /** Journey planner endpoints and result. Not undoable — it describes no edit. */
  routeFrom: StationId | null
  routeTo: StationId | null
  route: Route | null
  /** While set, clicking a station on the map fills that end of the journey. */
  routePick: 'from' | 'to' | null
  dirty: boolean

  // -- lifecycle
  loadProject: (p: Project) => void
  closeProject: () => void
  markSaved: () => void

  // -- history
  mutate: (label: string, recipe: (d: Project) => void, opts?: MutateOptions) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  undoLabel: () => string | null
  redoLabel: () => string | null

  // -- ui
  setSpace: (s: Space) => void
  setTool: (t: Tool) => void
  setSnapSuspended: (v: boolean) => void
  setTerrainKind: (k: TerrainKind) => void
  setRouteEnd: (which: 'from' | 'to', id: StationId | null) => void
  setRoutePick: (which: 'from' | 'to' | null) => void
  clearRoute: () => void

  // -- transport modes
  addMode: (name: string) => string | null
  updateMode: (id: string, patch: Partial<Omit<ModeStyle, 'id'>>) => void
  deleteMode: (id: string) => void
  select: (sel: Partial<Selection>, additive?: boolean) => void
  clearSelection: () => void
  setViewport: (space: Space, v: Partial<Viewport>) => void
  setActiveLine: (lineId: LineId | null, branchId?: string | null) => void

  // -- project meta
  renameProject: (name: string) => void

  // -- stations
  addStation: (pos: Vec2, space: Space, name?: string) => StationId
  setStationPos: (id: StationId, pos: Vec2, space: Space, opts?: MutateOptions) => void
  moveStations: (ids: StationId[], delta: Vec2, space: Space, opts?: MutateOptions) => void
  renameStation: (id: StationId, name: string) => void
  setLabel: (id: StationId, patch: Partial<StationLabel>, opts?: MutateOptions) => void
  resetLabel: (id: StationId) => void
  renameMany: (renames: { id: StationId; name: string }[], label?: string) => void
  setStationModes: (id: StationId, modes: ModeId[]) => void
  deleteStations: (ids: StationId[]) => void
  resetToGeographic: (ids: StationId[]) => void

  // -- lines
  addLine: (name?: string, mode?: ModeId) => LineId
  updateLine: (id: LineId, patch: Partial<Pick<Line, 'name' | 'mode' | 'color' | 'hidden'>>) => void
  deleteLine: (id: LineId) => void
  duplicateLine: (id: LineId) => LineId | null
  reorderLine: (id: LineId, toIndex: number) => void

  // -- branches and stops
  addBranch: (lineId: LineId, fromStop?: StationId, name?: string) => string | null
  deleteBranch: (lineId: LineId, branchId: string) => void
  appendStop: (lineId: LineId, branchId: string, stationId: StationId) => void
  insertStop: (lineId: LineId, branchId: string, index: number, stationId: StationId) => void
  removeStop: (lineId: LineId, branchId: string, index: number) => void
  reverseBranch: (lineId: LineId, branchId: string) => void
  /** Split a segment by dropping a brand-new station onto it. */
  addStationOnSegment: (
    lineId: LineId,
    branchId: string,
    index: number,
    pos: Vec2,
    space: Space,
  ) => StationId | null

  // -- bends
  addBend: (lineId: LineId, a: StationId, b: StationId, index: number, at: Bend) => void
  moveBend: (lineId: LineId, a: StationId, b: StationId, index: number, pos: Vec2, space: Space, opts?: MutateOptions) => void
  removeBend: (lineId: LineId, a: StationId, b: StationId, index: number) => void
  clearBends: (lineId: LineId, a: StationId, b: StationId) => void

  // -- corridors
  setCorridorOrder: (key: string, order: LineId[]) => void

  // -- per-crossing tuning
  setCrossingOverride: (key: string, patch: CrossingOverride) => void
  clearCrossingOverride: (key: string) => void

  // -- out-of-station interchanges
  addTransfer: (a: StationId, b: StationId, note?: string) => TransferId | null
  updateTransfer: (id: TransferId, patch: { note?: string; hidden?: boolean }) => void
  deleteTransfer: (id: TransferId) => void

  // -- terrain
  addTerrain: (kind: TerrainKind, points: Vec2[], space: Space, name?: string, closed?: boolean) => TerrainId
  updateTerrain: (id: TerrainId, patch: Partial<Omit<Terrain, 'id'>>) => void
  deleteTerrain: (ids: TerrainId[]) => void
  moveTerrain: (ids: TerrainId[], delta: Vec2, space: Space, opts?: MutateOptions) => void
  /** Drag one vertex of a traced shape. */
  moveTerrainPoint: (
    id: TerrainId,
    index: number,
    pos: Vec2,
    space: Space,
    opts?: MutateOptions,
  ) => void
  /** Add a vertex partway along a shape's edge, keeping both spaces aligned. */
  insertTerrainPoint: (id: TerrainId, index: number, pos: Vec2, space: Space) => void
  removeTerrainPoint: (id: TerrainId, index: number) => void
  simplifyTerrain: (id: TerrainId, epsilon: number) => void
  resetTerrainToGeographic: (ids: TerrainId[]) => void

  // -- images
  addImage: (img: ImageLayer) => void
  updateImage: (id: ImageId, patch: Partial<Omit<ImageLayer, 'id'>>, opts?: MutateOptions) => void
  deleteImages: (ids: ImageId[]) => void
  reorderImage: (id: ImageId, toIndex: number) => void

  // -- settings
  setSnap: (patch: Partial<SnapSettings>) => void
  setStyle: (patch: Partial<StyleSettings>) => void
  setView: (patch: Partial<ViewSettings>) => void
  applyStylePreset: (presetId: string) => void

  // -- layout commands
  straightenLine: (lineId: LineId) => void
  distributeEvenly: (ids: StationId[], space: Space) => void
  alignStations: (ids: StationId[], axis: 'x' | 'y', space: Space) => void
}

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditor = create<EditorState>((set, get) => {
  /** Shared helper: find a line in a draft. */
  const findLine = (d: Project, id: LineId): Line | undefined =>
    d.lines.find((l) => l.id === id)

  const findBranch = (d: Project, lineId: LineId, branchId: string): Branch | undefined =>
    findLine(d, lineId)?.branches.find((b) => b.id === branchId)

  return {
    project: null,
    past: [],
    future: [],

    space: 'geo',
    tool: 'select',
    selection: emptySelection(),
    viewports: { geo: { ...DEFAULT_VIEWPORT }, schematic: { ...DEFAULT_VIEWPORT } },
    activeLineId: null,
    activeBranchId: null,
    snapSuspended: false,
    terrainKind: 'waterway',
    routeFrom: null,
    routeTo: null,
    route: null,
    routePick: null,
    dirty: false,

    // ---------------------------------------------------------------- lifecycle

    loadProject: (p) => {
      // A project whose stations have been moved away from their real positions is one
      // you were composing, so open it in the diagram. A fresh or untouched one opens on
      // the map, where the work actually starts. This is also what makes the example
      // land on its finished diagram rather than a scatter of dots.
      const composed = p.stations.some(
        (s) => Math.abs(s.schematic.x - s.geo.x) > 1 || Math.abs(s.schematic.y - s.geo.y) > 1,
      )
      set({
        project: p,
        past: [],
        future: [],
        selection: emptySelection(),
        activeLineId: null,
        activeBranchId: null,
        space: composed ? 'schematic' : 'geo',
        routeFrom: null,
        routeTo: null,
        route: null,
        routePick: null,
        dirty: false,
      })
    },

    closeProject: () =>
      set({ project: null, past: [], future: [], selection: emptySelection(), dirty: false }),

    markSaved: () => set({ dirty: false }),

    // ------------------------------------------------------------------ history

    mutate: (label, recipe, opts) => {
      const state = get()
      if (!state.project) return

      const [afterRecipe, patches, inverse] = produceWithPatches(state.project, recipe)
      if (patches.length === 0) return

      // updatedAt is metadata, kept out of the patch record so undo does not have to
      // restore a timestamp and history entries stay about real edits.
      const next = produce(afterRecipe, (d) => {
        d.updatedAt = Date.now()
      })

      const now = Date.now()
      const past = state.past.slice()
      const top = past[past.length - 1]

      if (
        opts?.coalesceKey &&
        top &&
        top.coalesceKey === opts.coalesceKey &&
        now - top.at < COALESCE_WINDOW_MS
      ) {
        // To undo P1 then P2 you must apply inv(P2) before inv(P1), hence the prepend.
        past[past.length - 1] = {
          ...top,
          patches: [...top.patches, ...patches],
          inverse: [...inverse, ...top.inverse],
          at: now,
        }
      } else {
        past.push({ label, patches, inverse, coalesceKey: opts?.coalesceKey, at: now })
        if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT)
      }

      set({ project: next, past, future: [], dirty: true })
    },

    undo: () => {
      const { project, past, future } = get()
      if (!project || past.length === 0) return
      const entry = past[past.length - 1]
      set({
        project: applyPatches(project, entry.inverse),
        past: past.slice(0, -1),
        future: [entry, ...future],
        dirty: true,
      })
    },

    redo: () => {
      const { project, past, future } = get()
      if (!project || future.length === 0) return
      const entry = future[0]
      set({
        project: applyPatches(project, entry.patches),
        past: [...past, entry],
        future: future.slice(1),
        dirty: true,
      })
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
    undoLabel: () => get().past[get().past.length - 1]?.label ?? null,
    redoLabel: () => get().future[0]?.label ?? null,

    // ----------------------------------------------------------------------- ui

    setSpace: (s) => set({ space: s }),
    setTool: (t) => set({ tool: t }),
    setSnapSuspended: (v) => set({ snapSuspended: v }),
    setTerrainKind: (k) => set({ terrainKind: k }),

    setRouteEnd: (which, id) => {
      set(which === 'from' ? { routeFrom: id } : { routeTo: id })
      const st = get()
      const { project, routeFrom, routeTo } = st
      if (!project || !routeFrom || !routeTo) {
        set({ route: null })
        return
      }
      set({ route: findRoute(project, networkOf(project), routeFrom, routeTo) })
    },

    setRoutePick: (which) => set({ routePick: which }),

    clearRoute: () =>
      set({ routeFrom: null, routeTo: null, route: null, routePick: null }),

    // ------------------------------------------------------------- modes

    addMode: (name) => {
      const id = `mode_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${Date.now().toString(36)}`
      let ok = false
      get().mutate('Add a transport mode', (d) => {
        ok = true
        const used = d.modes.map((m) => m.color)
        d.modes.push({
          id,
          name,
          color: nextUnusedColor(used),
          strokeWidth: 6,
          stationSymbol: 'circle',
          z: Math.max(0, ...d.modes.map((m) => m.z)) + 5,
        })
      })
      return ok ? id : null
    },

    updateMode: (id, patch) =>
      get().mutate('Change a transport mode', (d) => {
        const m = d.modes.find((x) => x.id === id)
        if (m) Object.assign(m, patch)
      }, { coalesceKey: `mode-${id}` }),

    deleteMode: (id) =>
      get().mutate('Delete a transport mode', (d) => {
        if (d.modes.length <= 1) return
        d.modes = d.modes.filter((m) => m.id !== id)
        // A line pointing at a mode that no longer exists would lose its whole style,
        // so anything using it falls back to the first remaining mode.
        const fallback = d.modes[0].id
        for (const l of d.lines) if (l.mode === id) l.mode = fallback
      }),

    select: (sel, additive = false) =>
      set((s) => {
        if (!additive) return { selection: { ...emptySelection(), ...sel } }
        const cur = s.selection
        const merge = <T,>(a: T[], b?: T[]) => (b ? [...new Set([...a, ...b])] : a)
        return {
          selection: {
            stations: merge(cur.stations, sel.stations),
            lines: merge(cur.lines, sel.lines),
            terrain: merge(cur.terrain, sel.terrain),
            images: merge(cur.images, sel.images),
            transfers: merge(cur.transfers, sel.transfers),
            crossings: merge(cur.crossings, sel.crossings),
          },
        }
      }),

    clearSelection: () => set({ selection: emptySelection() }),

    setViewport: (space, v) =>
      set((s) => ({
        viewports: { ...s.viewports, [space]: { ...s.viewports[space], ...v } },
      })),

    setActiveLine: (lineId, branchId = null) =>
      set({ activeLineId: lineId, activeBranchId: branchId }),

    // ------------------------------------------------------------- project meta

    renameProject: (name) => get().mutate('Rename project', (d) => { d.name = name }),

    // ----------------------------------------------------------------- stations

    addStation: (pos, space, name = '') => {
      const id = newStationId()
      // Both spaces start at the drawn position; only the active one is authoritative
      // until the station is moved in the other.
      void space
      const station: Station = makeStation(id, name, pos)
      get().mutate('Add station', (d) => { d.stations.push(station) })
      return id
    },

    setStationPos: (id, pos, space, opts) =>
      get().mutate('Move station', (d) => {
        const s = d.stations.find((x) => x.id === id)
        if (s) s[space] = { ...pos }
      }, opts ?? { coalesceKey: `move-station-${id}-${space}` }),

    moveStations: (ids, delta, space, opts) =>
      get().mutate('Move stations', (d) => {
        for (const id of ids) {
          const s = d.stations.find((x) => x.id === id)
          if (s) s[space] = add(s[space], delta)
        }
      }, opts ?? { coalesceKey: `move-many-${ids.join(',')}-${space}` }),

    renameStation: (id, name) =>
      get().mutate('Rename station', (d) => {
        const s = d.stations.find((x) => x.id === id)
        if (s) s.name = name
      }, { coalesceKey: `rename-station-${id}` }),

    setLabel: (id, patch, opts) =>
      get().mutate('Move label', (d) => {
        const s = d.stations.find((x) => x.id === id)
        if (!s) return
        // Callers routinely pass `anchor: undefined` to mean "leave it alone"; a bare
        // Object.assign would instead wipe the anchor and break placement.
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) (s.label as unknown as Record<string, unknown>)[k] = v
        }
      }, opts ?? { coalesceKey: `label-${id}` }),

    resetLabel: (id) =>
      get().mutate('Reset label', (d) => {
        const s = d.stations.find((x) => x.id === id)
        // Handing it back to the placement engine means clearing BOTH the anchor and
        // the manual nudge; leaving the offset behind would silently skew the result.
        if (s) s.label = { ...s.label, anchor: 'auto', offset: { x: 0, y: 0 }, pinned: false }
      }),

    renameMany: (renames, label = 'Rename stations') =>
      get().mutate(label, (d) => {
        const byId = new Map(renames.map((r) => [r.id, r.name]))
        for (const s of d.stations) {
          const next = byId.get(s.id)
          if (next !== undefined) s.name = next
        }
      }),

    setStationModes: (id, modes) =>
      get().mutate('Change station modes', (d) => {
        const s = d.stations.find((x) => x.id === id)
        if (s) s.modes = [...modes]
      }),

    deleteStations: (ids) => {
      const kill = new Set(ids)
      get().mutate(ids.length > 1 ? 'Delete stations' : 'Delete station', (d) => {
        d.stations = d.stations.filter((s) => !kill.has(s.id))
        // Pull them out of every branch, and drop any bend that referenced them.
        for (const line of d.lines) {
          for (const branch of line.branches) {
            branch.stops = branch.stops.filter((s) => !kill.has(s))
          }
          line.branches = line.branches.filter((b) => b.stops.length > 0)
          for (const key of Object.keys(line.bends)) {
            const [a, b] = key.split('|') as [StationId, StationId]
            if (kill.has(a) || kill.has(b)) delete line.bends[key]
          }
        }
        for (const key of Object.keys(d.corridorOrder)) {
          const [a, b] = key.split('|') as [StationId, StationId]
          if (kill.has(a) || kill.has(b)) delete d.corridorOrder[key]
        }
        d.transfers = d.transfers.filter((t) => !kill.has(t.a) && !kill.has(t.b))
      })
      set((s) => ({ selection: { ...s.selection, stations: [] } }))
    },

    resetToGeographic: (ids) =>
      get().mutate('Reset to geographic position', (d) => {
        for (const id of ids) {
          const s = d.stations.find((x) => x.id === id)
          if (s) s.schematic = { ...s.geo }
        }
      }),

    // -------------------------------------------------------------------- lines

    addLine: (name, mode = 'metro') => {
      const id = newLineId()
      const branchId = newBranchId()
      const used = (get().project?.lines ?? []).map((l) => l.color)
      const line: Line = {
        id,
        name: name ?? `Line ${(get().project?.lines.length ?? 0) + 1}`,
        mode,
        color: nextUnusedColor(used),
        branches: [makeBranch(branchId)],
        bends: {},
        hidden: false,
      }
      get().mutate('Add line', (d) => { d.lines.push(line) })
      set({ activeLineId: id, activeBranchId: branchId })
      return id
    },

    updateLine: (id, patch) =>
      get().mutate('Update line', (d) => {
        const l = findLine(d, id)
        if (l) Object.assign(l, patch)
      }, { coalesceKey: `update-line-${id}` }),

    deleteLine: (id) => {
      get().mutate('Delete line', (d) => {
        d.lines = d.lines.filter((l) => l.id !== id)
        for (const key of Object.keys(d.corridorOrder)) {
          d.corridorOrder[key] = d.corridorOrder[key].filter((x) => x !== id)
          if (d.corridorOrder[key].length === 0) delete d.corridorOrder[key]
        }
      })
      set((s) => ({
        selection: { ...s.selection, lines: s.selection.lines.filter((x) => x !== id) },
        activeLineId: s.activeLineId === id ? null : s.activeLineId,
      }))
    },

    duplicateLine: (id) => {
      const project = get().project
      const src = project?.lines.find((l) => l.id === id)
      if (!project || !src) return null
      const newId = newLineId()
      const copy: Line = {
        ...src,
        id: newId,
        name: `${src.name} copy`,
        color: nextUnusedColor(project.lines.map((l) => l.color)),
        branches: src.branches.map((b) => ({ ...b, id: newBranchId(), stops: [...b.stops] })),
        bends: Object.fromEntries(
          Object.entries(src.bends).map(([k, v]) => [k, v.map((p) => ({ geo: { ...p.geo }, schematic: { ...p.schematic } }))]),
        ),
      }
      get().mutate('Duplicate line', (d) => {
        const at = d.lines.findIndex((l) => l.id === id)
        d.lines.splice(at + 1, 0, copy)
      })
      return newId
    },

    reorderLine: (id, toIndex) =>
      get().mutate('Reorder line', (d) => {
        const from = d.lines.findIndex((l) => l.id === id)
        if (from < 0) return
        const [l] = d.lines.splice(from, 1)
        d.lines.splice(Math.max(0, Math.min(d.lines.length, toIndex)), 0, l)
      }),

    // --------------------------------------------------------- branches + stops

    addBranch: (lineId, fromStop, name) => {
      const branchId = newBranchId()
      let ok = false
      get().mutate('Add branch', (d) => {
        const l = findLine(d, lineId)
        if (!l) return
        ok = true
        // Seeding from a junction stop is what makes a Y: the new branch starts at an
        // existing station on the line rather than floating free.
        l.branches.push(makeBranch(branchId, fromStop ? [fromStop] : [], { name }))
      })
      if (!ok) return null
      set({ activeLineId: lineId, activeBranchId: branchId })
      return branchId
    },

    deleteBranch: (lineId, branchId) =>
      get().mutate('Delete branch', (d) => {
        const l = findLine(d, lineId)
        if (!l) return
        l.branches = l.branches.filter((b) => b.id !== branchId)
        if (l.branches.length === 0) l.branches.push(makeBranch(newBranchId()))
      }),

    appendStop: (lineId, branchId, stationId) =>
      get().mutate('Add stop', (d) => {
        const b = findBranch(d, lineId, branchId)
        if (!b) return
        if (b.stops[b.stops.length - 1] === stationId) return // no self-loop segments
        b.stops.push(stationId)
      }),

    insertStop: (lineId, branchId, index, stationId) =>
      get().mutate('Insert stop', (d) => {
        const b = findBranch(d, lineId, branchId)
        if (!b) return
        b.stops.splice(Math.max(0, Math.min(b.stops.length, index)), 0, stationId)
      }),

    removeStop: (lineId, branchId, index) =>
      get().mutate('Remove stop', (d) => {
        const b = findBranch(d, lineId, branchId)
        if (b) b.stops.splice(index, 1)
      }),

    reverseBranch: (lineId, branchId) =>
      get().mutate('Reverse branch', (d) => {
        const b = findBranch(d, lineId, branchId)
        if (b) b.stops.reverse()
      }),

    addStationOnSegment: (lineId, branchId, index, pos, space) => {
      const id = newStationId()
      let ok = false
      get().mutate('Insert station on line', (d) => {
        const l = d.lines.find((x) => x.id === lineId)
        const b = l?.branches.find((x) => x.id === branchId)
        if (!l || !b) return
        ok = true
        d.stations.push(makeStation(id, '', pos, { modes: [l.mode] }))
        b.stops.splice(index + 1, 0, id)
        // The old segment's bends described a route that no longer exists once a
        // station splits it, so they are dropped rather than left pointing nowhere.
        const a = b.stops[index]
        const c = b.stops[index + 2]
        if (a && c) delete l.bends[segmentKey(a, c)]
      })
      void space
      return ok ? id : null
    },

    // -------------------------------------------------------------------- bends

    addBend: (lineId, a, b, index, at) =>
      get().mutate('Add bend', (d) => {
        const l = findLine(d, lineId)
        if (!l) return
        const key = segmentKey(a, b)
        const list = (l.bends[key] ??= [])
        // Bends are stored in canonical order; a reverse traversal mirrors the index.
        const i = a < b ? index : list.length - index
        list.splice(Math.max(0, Math.min(list.length, i)), 0, at)
      }),

    moveBend: (lineId, a, b, index, pos, space, opts) =>
      get().mutate('Move bend', (d) => {
        const l = findLine(d, lineId)
        if (!l) return
        const list = l.bends[segmentKey(a, b)]
        const bend = list?.[a < b ? index : list.length - 1 - index]
        if (bend) bend[space] = { ...pos }
      }, opts ?? { coalesceKey: `move-bend-${lineId}-${segmentKey(a, b)}-${index}` }),

    removeBend: (lineId, a, b, index) =>
      get().mutate('Remove bend', (d) => {
        const l = findLine(d, lineId)
        if (!l) return
        const key = segmentKey(a, b)
        const list = l.bends[key]
        if (!list) return
        list.splice(a < b ? index : list.length - 1 - index, 1)
        if (list.length === 0) delete l.bends[key]
      }),

    clearBends: (lineId, a, b) =>
      get().mutate('Straighten segment', (d) => {
        const l = findLine(d, lineId)
        if (l) delete l.bends[segmentKey(a, b)]
      }),

    // ---------------------------------------------------------------- corridors

    setCorridorOrder: (key, order) =>
      get().mutate('Reorder corridor', (d) => {
        d.corridorOrder[key] = [...order]
      }),

    setCrossingOverride: (key, patch) =>
      get().mutate('Adjust a crossing', (d) => {
        d.crossings[key] = { ...(d.crossings[key] ?? {}), ...patch }
      }, { coalesceKey: `crossing-${key}` }),

    clearCrossingOverride: (key) =>
      get().mutate('Reset a crossing', (d) => {
        delete d.crossings[key]
      }),

    // ------------------------------------------- out-of-station interchanges

    addTransfer: (a, b, note = '') => {
      const id = newTransferId()
      let ok = false
      get().mutate('Link stations', (d) => {
        if (a === b) return
        // One link per pair, in either direction — two would just draw on top of
        // each other and both would have to be deleted to get rid of it.
        const exists = d.transfers.some(
          (t) => (t.a === a && t.b === b) || (t.a === b && t.b === a),
        )
        if (exists) return
        ok = true
        d.transfers.push({ id, a, b, note, hidden: false })
      })
      return ok ? id : null
    },

    updateTransfer: (id, patch) =>
      get().mutate('Update the link', (d) => {
        const t = d.transfers.find((x) => x.id === id)
        if (t) Object.assign(t, patch)
      }, { coalesceKey: `transfer-${id}` }),

    deleteTransfer: (id) =>
      get().mutate('Remove the link', (d) => {
        d.transfers = d.transfers.filter((t) => t.id !== id)
      }),

    // ------------------------------------------------------------------ terrain

    addTerrain: (kind, points, space, name = '', closed = false) => {
      const id = newTerrainId()
      const pts = points.map((p) => ({ ...p }))
      const t: Terrain = makeTerrain(id, kind, {
        name,
        geo: pts.map((p) => ({ ...p })),
        schematic: pts.map((p) => ({ ...p })),
        closed,
      })
      // Only the space it was drawn in is authoritative; the other starts as a copy.
      void space
      get().mutate('Add terrain', (d) => { d.terrain.push(t) })
      return id
    },

    updateTerrain: (id, patch) =>
      get().mutate('Update terrain', (d) => {
        const t = d.terrain.find((x) => x.id === id)
        if (t) Object.assign(t, patch)
      }, { coalesceKey: `update-terrain-${id}` }),

    deleteTerrain: (ids) => {
      const kill = new Set(ids)
      get().mutate('Delete terrain', (d) => {
        d.terrain = d.terrain.filter((t) => !kill.has(t.id))
      })
      set((s) => ({ selection: { ...s.selection, terrain: [] } }))
    },

    moveTerrain: (ids, delta, space, opts) =>
      get().mutate('Move terrain', (d) => {
        const kill = new Set(ids)
        for (const t of d.terrain) {
          if (!kill.has(t.id)) continue
          t[space] = t[space].map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }))
        }
      }, opts ?? { coalesceKey: `terrain-${ids.join(',')}-${space}` }),

    moveTerrainPoint: (id, index, pos, space, opts) =>
      get().mutate('Reshape terrain', (d) => {
        const t = d.terrain.find((x) => x.id === id)
        if (t && t[space][index]) t[space][index] = { ...pos }
      }, opts ?? { coalesceKey: `terrain-pt-${id}-${index}-${space}` }),

    insertTerrainPoint: (id, index, pos, space) =>
      get().mutate('Add a corner', (d) => {
        const t = d.terrain.find((x) => x.id === id)
        if (!t) return
        const other: Space = space === 'geo' ? 'schematic' : 'geo'
        // Both spaces are index-aligned, so a vertex has to appear in both. The space
        // you are not looking at gets the midpoint of its own edge, which leaves that
        // view's shape unchanged.
        const a = t[other][index]
        const b = t[other][index + 1] ?? t[other][index]
        const mid =
          a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { ...pos }

        t[space].splice(index + 1, 0, { ...pos })
        t[other].splice(index + 1, 0, mid)
      }),

    removeTerrainPoint: (id, index) =>
      get().mutate('Remove a corner', (d) => {
        const t = d.terrain.find((x) => x.id === id)
        if (!t) return
        // Below three points a polygon stops being a shape, and below two a line stops
        // being a line, so refuse rather than leave something undrawable.
        const floor = t.closed ? 3 : 2
        if (t.geo.length <= floor || t.schematic.length <= floor) return
        t.geo.splice(index, 1)
        t.schematic.splice(index, 1)
      }),

    simplifyTerrain: (id, epsilon) =>
      get().mutate('Simplify terrain', (d) => {
        const t = d.terrain.find((x) => x.id === id)
        if (!t) return
        // Simplify the diagram form only — the traced form stays as ground truth.
        t.schematic = simplify(t.schematic, epsilon)
      }),

    resetTerrainToGeographic: (ids) =>
      get().mutate('Reset terrain shape', (d) => {
        for (const id of ids) {
          const t = d.terrain.find((x) => x.id === id)
          if (t) t.schematic = t.geo.map((p) => ({ ...p }))
        }
      }),

    // ------------------------------------------------------------------- images

    addImage: (img) => get().mutate('Add image', (d) => { d.images.push(img) }),

    updateImage: (id, patch, opts) =>
      get().mutate('Move image', (d) => {
        const i = d.images.find((x) => x.id === id)
        if (i && !(i.locked && ('x' in patch || 'y' in patch))) Object.assign(i, patch)
      }, opts ?? { coalesceKey: `update-image-${id}` }),

    deleteImages: (ids) => {
      const kill = new Set(ids)
      get().mutate('Delete image', (d) => {
        d.images = d.images.filter((i) => !kill.has(i.id))
      })
      set((s) => ({ selection: { ...s.selection, images: [] } }))
    },

    reorderImage: (id, toIndex) =>
      get().mutate('Reorder image', (d) => {
        const from = d.images.findIndex((i) => i.id === id)
        if (from < 0) return
        const [i] = d.images.splice(from, 1)
        d.images.splice(Math.max(0, Math.min(d.images.length, toIndex)), 0, i)
      }),

    // ----------------------------------------------------------------- settings

    setSnap: (patch) =>
      get().mutate('Change snapping', (d) => { Object.assign(d.snap, patch) }, {
        coalesceKey: 'snap-settings',
      }),

    setStyle: (patch) =>
      get().mutate('Change style', (d) => { Object.assign(d.style, patch) }, {
        coalesceKey: 'style-settings',
      }),

    setView: (patch) =>
      get().mutate('Change view', (d) => { Object.assign(d.view, patch) }, {
        coalesceKey: 'view-settings',
      }),

    applyStylePreset: (presetId) =>
      get().mutate('Apply style preset', (d) => {
        const p = presetById(presetId)
        d.style = { presetId: p.id, ...p.style }
      }),

    // ---------------------------------------------------------- layout commands

    straightenLine: (lineId) =>
      get().mutate('Straighten line', (d) => {
        const l = findLine(d, lineId)
        if (!l) return
        // One line at a time, leaving the rest of the map alone. Junction stations
        // shared with other branches move too — that is the honest behaviour, and it
        // is one undo step away.
        const moved = new Set<StationId>()
        for (const branch of l.branches) {
          const pts = branch.stops
            .map((id) => d.stations.find((s) => s.id === id))
            .filter((s): s is Station => !!s)
          if (pts.length < 2) continue
          const snapped = octilinearizeRun(pts.map((s) => s.schematic))
          pts.forEach((s, i) => {
            if (moved.has(s.id)) return
            s.schematic = snapped[i]
            moved.add(s.id)
          })
        }

        // Straightening the stations is not enough on its own: a manual bend added in
        // this view would survive and leave the line still wiggling. Rather than delete
        // the bends — which would destroy hand work, and this app never does that — each
        // one is slid onto the straight run and spaced evenly along it. The line comes
        // out genuinely straight, the geographic route is untouched, and every handle is
        // still there to drag back out.
        for (const branch of l.branches) {
          for (let i = 0; i < branch.stops.length - 1; i++) {
            const a = branch.stops[i]
            const b = branch.stops[i + 1]
            if (a === b) continue
            const list = l.bends[segmentKey(a, b)]
            if (!list || list.length === 0) continue
            const sa = d.stations.find((s) => s.id === a)
            const sb = d.stations.find((s) => s.id === b)
            if (!sa || !sb) continue
            // Bends are stored canonically. On a reversed traversal the spacing has to
            // be mirrored, or the handles end up ordered against the direction of travel
            // and the "straightened" line doubles back through them.
            const forward = a < b
            list.forEach((bend, k) => {
              const step = (k + 1) / (list.length + 1)
              const t = forward ? step : 1 - step
              bend.schematic = {
                x: sa.schematic.x + (sb.schematic.x - sa.schematic.x) * t,
                y: sa.schematic.y + (sb.schematic.y - sa.schematic.y) * t,
              }
            })
          }
        }
      }),

    distributeEvenly: (ids, space) =>
      get().mutate('Distribute evenly', (d) => {
        const list = ids
          .map((id) => d.stations.find((s) => s.id === id))
          .filter((s): s is Station => !!s)
        if (list.length < 3) return
        const first = list[0][space]
        const last = list[list.length - 1][space]
        const n = list.length - 1
        list.forEach((s, i) => {
          if (i === 0 || i === n) return
          s[space] = {
            x: first.x + ((last.x - first.x) * i) / n,
            y: first.y + ((last.y - first.y) * i) / n,
          }
        })
      }),

    alignStations: (ids, axis, space) =>
      get().mutate(`Align ${axis === 'x' ? 'vertically' : 'horizontally'}`, (d) => {
        const list = ids
          .map((id) => d.stations.find((s) => s.id === id))
          .filter((s): s is Station => !!s)
        if (list.length < 2) return
        const avg = list.reduce((a, s) => a + s[space][axis], 0) / list.length
        for (const s of list) s[space] = { ...s[space], [axis]: avg }
      }),
  }
})

// ---------------------------------------------------------------------------
// Convenience selectors
// ---------------------------------------------------------------------------

export const useProject = () => useEditor((s) => s.project)
export const useSpace = () => useEditor((s) => s.space)
export const useSelection = () => useEditor((s) => s.selection)

export function useNetwork(): Network | null {
  const project = useEditor((s) => s.project)
  return project ? networkOf(project) : null
}

/** Distance between two stations in the active space; used by spacing snap. */
export function gapBetween(p: Project, a: StationId, b: StationId, space: Space): number {
  const sa = p.stations.find((s) => s.id === a)
  const sb = p.stations.find((s) => s.id === b)
  if (!sa || !sb) return 0
  return dist(sa[space], sb[space])
}

export { sub }
