/**
 * Everything derived from the network graph.
 *
 * Nothing in here is ever persisted. Interchanges, shared corridors, parallel offsets
 * and terminus caps are recomputed from each line's `stops` whenever the project
 * changes, which is precisely why they cannot fall out of sync with the graph.
 */

import type {
  Branch,
  Line,
  LineId,
  Project,
  SegmentKey,
  Station,
  StationId,
  Vec2,
} from './types'

export type Space = 'geo' | 'schematic'

// ---------------------------------------------------------------------------
// Segment keys
// ---------------------------------------------------------------------------

/**
 * Canonical, direction-free key for the corridor between two stations. Always ordered
 * `${min}|${max}` so a line running A->B and one running B->A land on the same key.
 */
export function segmentKey(a: StationId, b: StationId): SegmentKey {
  return (a < b ? `${a}|${b}` : `${b}|${a}`) as SegmentKey
}

export function splitSegmentKey(key: SegmentKey | string): [StationId, StationId] {
  const i = key.indexOf('|')
  return [key.slice(0, i) as StationId, key.slice(i + 1) as StationId]
}

/** True when travelling a->b runs in the same direction the key is stored in. */
export const isForward = (a: StationId, b: StationId): boolean => a < b

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export interface Traversal {
  lineId: LineId
  branchId: string
  /** Index of the from-stop within the branch. */
  index: number
  a: StationId
  b: StationId
  key: SegmentKey
  forward: boolean
}

/** Every consecutive stop pair of a line, across all its branches. */
export function* lineTraversals(line: Line): Generator<Traversal> {
  for (const branch of line.branches) {
    for (let i = 0; i < branch.stops.length - 1; i++) {
      const a = branch.stops[i]
      const b = branch.stops[i + 1]
      if (a === b) continue
      yield {
        lineId: line.id,
        branchId: branch.id,
        index: i,
        a,
        b,
        key: segmentKey(a, b),
        forward: isForward(a, b),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The derived network
// ---------------------------------------------------------------------------

export interface Network {
  /** Corridor key -> the distinct lines using it, already in draw order. */
  corridors: Map<string, LineId[]>
  /** Corridor key -> line -> signed lateral offset, in CANONICAL direction. */
  offsets: Map<string, Map<LineId, number>>
  /** Station -> lines serving it, in project order. */
  linesAtStation: Map<StationId, LineId[]>
  /** Undirected adjacency. */
  neighbours: Map<StationId, Set<StationId>>
  /** Per line, the stations where a branch genuinely ends (junctions excluded). */
  terminiByLine: Map<LineId, Set<StationId>>
  /** Stations served by more than one line. */
  interchanges: Set<StationId>
  /** Stations no visible line touches. */
  orphans: Set<StationId>
}

export function buildNetwork(project: Project): Network {
  const spacing = project.style.corridorSpacing
  const lineOrder = new Map<LineId, number>()
  project.lines.forEach((l, i) => lineOrder.set(l.id, i))

  const known = new Set<StationId>(project.stations.map((s) => s.id))

  const corridorSets = new Map<string, Set<LineId>>()
  const linesAt = new Map<StationId, Set<LineId>>()
  const neighbours = new Map<StationId, Set<StationId>>()
  const endpoints = new Map<LineId, Set<StationId>>()
  const interiors = new Map<LineId, Set<StationId>>()

  const touch = <K, V>(m: Map<K, Set<V>>, k: K): Set<V> => {
    let s = m.get(k)
    if (!s) m.set(k, (s = new Set<V>()))
    return s
  }

  for (const line of project.lines) {
    // A hidden line yields its slot so the remaining lines close up rather than
    // leaving a gap where it used to be.
    if (line.hidden) continue

    for (const branch of line.branches) {
      const stops = branch.stops.filter((id) => known.has(id))
      if (stops.length === 0) continue

      stops.forEach((id, i) => {
        touch(linesAt, id).add(line.id)
        if (i > 0 && i < stops.length - 1) touch(interiors, line.id).add(id)
      })
      touch(endpoints, line.id).add(stops[0])
      touch(endpoints, line.id).add(stops[stops.length - 1])

      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i]
        const b = stops[i + 1]
        if (a === b) continue
        touch(corridorSets, segmentKey(a, b)).add(line.id)
        touch(neighbours, a).add(b)
        touch(neighbours, b).add(a)
      }
    }
  }

  const byProjectOrder = (x: LineId, y: LineId) =>
    (lineOrder.get(x) ?? 0) - (lineOrder.get(y) ?? 0)

  const corridors = new Map<string, LineId[]>()
  const offsets = new Map<string, Map<LineId, number>>()

  for (const [key, set] of corridorSets) {
    const override = project.corridorOrder[key]
    let ordered: LineId[]

    if (override && override.length > 0) {
      const pinned = override.filter((id) => set.has(id))
      const rest = [...set].filter((id) => !pinned.includes(id)).sort(byProjectOrder)
      ordered = [...pinned, ...rest]
    } else {
      // Default = project line order. Using one global ordering (rather than deciding
      // per corridor) is what keeps a line on the same side of its neighbours across
      // consecutive shared segments, with no extra bookkeeping.
      ordered = [...set].sort(byProjectOrder)
    }

    corridors.set(key, ordered)
    const m = new Map<LineId, number>()
    const n = ordered.length
    ordered.forEach((id, i) => m.set(id, (i - (n - 1) / 2) * spacing))
    offsets.set(key, m)
  }

  const linesAtStation = new Map<StationId, LineId[]>()
  const interchanges = new Set<StationId>()
  for (const [id, set] of linesAt) {
    const arr = [...set].sort(byProjectOrder)
    linesAtStation.set(id, arr)
    if (arr.length > 1) interchanges.add(id)
  }

  const terminiByLine = new Map<LineId, Set<StationId>>()
  for (const [lineId, ends] of endpoints) {
    const inner = interiors.get(lineId)
    const real = new Set<StationId>()
    for (const id of ends) if (!inner?.has(id)) real.add(id)
    terminiByLine.set(lineId, real)
  }

  const orphans = new Set<StationId>()
  for (const s of project.stations) if (!linesAtStation.has(s.id)) orphans.add(s.id)

  return {
    corridors,
    offsets,
    linesAtStation,
    neighbours,
    terminiByLine,
    interchanges,
    orphans,
  }
}

// ---------------------------------------------------------------------------
// Geometry for one branch
// ---------------------------------------------------------------------------

export interface BranchGeometry {
  /** Centreline through stops and any manual bends, in the requested space. */
  points: Vec2[]
  /** Lateral offset per segment, relative to DIRECTION OF TRAVEL. */
  offsets: number[]
  /** Index into `points` of each stop, for placing station symbols. */
  stopIndices: number[]
  /**
   * The branch's stops after dropping any that reference deleted stations. Aligned
   * with `stopIndices`, so callers can map a clicked sub-path back to a real pair.
   */
  stops: StationId[]
}

export function stationMap(project: Project): Map<StationId, Station> {
  return new Map(project.stations.map((s) => [s.id, s]))
}

/**
 * Build the raw centreline for a branch plus the offset each segment should be drawn
 * at. The offsets stored in `Network` are canonical (direction-free) so that every line
 * sharing a corridor agrees on who sits where; here they are converted to
 * travel-relative by negating on anti-canonical traversals. Without that flip, a line
 * that happens to run "backwards" along a corridor would cross to the other side
 * halfway through.
 */
export function branchGeometry(
  project: Project,
  network: Network,
  line: Line,
  branch: Branch,
  space: Space,
  stations: Map<StationId, Station> = stationMap(project),
): BranchGeometry | null {
  const stops = branch.stops.filter((id) => stations.has(id))
  if (stops.length < 2) return null

  const points: Vec2[] = []
  const offsets: number[] = []
  const stopIndices: number[] = []

  const first = stations.get(stops[0])!
  points.push({ ...first[space] })
  stopIndices.push(0)
  const kept: StationId[] = [stops[0]]

  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (a === b) continue

    const key = segmentKey(a, b)
    const forward = isForward(a, b)
    const canonical = network.offsets.get(key)?.get(line.id) ?? 0
    const travel = forward ? canonical : -canonical

    const stored = line.bends[key] ?? []
    const bends = forward ? stored : [...stored].reverse()
    for (const bend of bends) {
      points.push({ ...bend[space] })
      offsets.push(travel)
    }

    points.push({ ...stations.get(b)![space] })
    offsets.push(travel)
    stopIndices.push(points.length - 1)
    kept.push(b)
  }

  if (points.length < 2) return null
  return { points, offsets, stopIndices, stops: kept }
}

// ---------------------------------------------------------------------------
// Small queries used across the UI
// ---------------------------------------------------------------------------

export function linesServing(network: Network, id: StationId): LineId[] {
  return network.linesAtStation.get(id) ?? []
}

export function isTerminus(network: Network, lineId: LineId, id: StationId): boolean {
  return network.terminiByLine.get(lineId)?.has(id) ?? false
}

/** How many distinct lines run through a station — drives the symbol chosen for it. */
export function stationDegree(network: Network, id: StationId): number {
  return network.linesAtStation.get(id)?.length ?? 0
}

export function corridorLines(network: Network, key: SegmentKey | string): LineId[] {
  return network.corridors.get(key) ?? []
}

/** Total stop count across every branch, counting a junction once per branch. */
export function lineStopCount(line: Line): number {
  return line.branches.reduce((n, b) => n + b.stops.length, 0)
}

export function allStopsOfLine(line: Line): Set<StationId> {
  const out = new Set<StationId>()
  for (const b of line.branches) for (const id of b.stops) out.add(id)
  return out
}
