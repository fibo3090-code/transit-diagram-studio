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

/**
 * A branch whose last stop repeats its first: a ring.
 *
 * Worth naming because a ring has no ends. Treating its join station as a terminus --
 * which is what a first-and-last test does on its own -- puts a route bullet in the
 * middle of the Circle line.
 */
export function isRing(branch: Branch): boolean {
  const s = branch.stops
  return s.length > 2 && s[0] === s[s.length - 1]
}

/** Same test, applied after stops referencing deleted stations have been dropped. */
const closesOnItself = (stops: StationId[]): boolean =>
  stops.length > 2 && stops[0] === stops[stops.length - 1]

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
  const stationPositions = stationMap(project)

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

      // Where it CALLS drives interchanges and termini...
      stops.forEach((id, i) => {
        touch(linesAt, id).add(line.id)
        if (i > 0 && i < stops.length - 1) touch(interiors, line.id).add(id)
      })
      // A ring ends nowhere. Its join station is both first and last, and the interior
      // test cannot catch it, so it would otherwise be reported as a terminus.
      if (!closesOnItself(stops)) {
        touch(endpoints, line.id).add(stops[0])
        touch(endpoints, line.id).add(stops[stops.length - 1])
      }

      // ...but where it RUNS drives corridors, so an express and the local beside it
      // agree on which segments they share and get parallel offsets rather than
      // stacking on top of one another.
      const { ids: through } = branchSequence(branch, stationPositions, 'schematic')
      for (let i = 0; i < through.length - 1; i++) {
        const a = through[i]
        const b = through[i + 1]
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
 * Order the stations a branch passes through without stopping along one segment.
 *
 * `passes` is a flat set rather than a per-segment map, because asking someone to say
 * WHICH segment a skipped station belongs to is asking them to restate something the
 * geometry already knows. Each candidate is projected onto the segment; those landing
 * between its ends belong to it, ordered by how far along they sit.
 *
 * A station is assigned to the segment it projects most squarely onto, so an express
 * skipping stops on several consecutive segments distributes them correctly instead of
 * piling them all onto the first.
 */
function passedAlong(
  a: Vec2,
  b: Vec2,
  candidates: { id: StationId; at: Vec2 }[],
): { id: StationId; at: Vec2; t: number }[] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return []
  const out: { id: StationId; at: Vec2; t: number }[] = []
  for (const c of candidates) {
    const t = ((c.at.x - a.x) * dx + (c.at.y - a.y) * dy) / len2
    if (t <= 1e-6 || t >= 1 - 1e-6) continue
    out.push({ id: c.id, at: c.at, t })
  }
  return out.sort((x, y) => x.t - y.t)
}

/**
 * The stations a branch physically runs through, in order, calls and pass-throughs
 * alike.
 *
 * This is what a branch actually occupies, as opposed to where it stops, and both the
 * corridor map and the drawn geometry are built from it.
 *
 * Getting that wrong is subtle and very visible: an express calling at A and D while
 * running through B and C used to register one corridor A-D, while the local beside it
 * registered A-B, B-C, C-D. No key matched, so neither line knew it shared a corridor,
 * both took offset zero, and the express was drawn straight over the top of the local
 * instead of alongside it.
 */
export function branchSequence(
  branch: Branch,
  stations: Map<StationId, Station>,
  space: Space,
): { ids: StationId[]; calls: boolean[] } {
  const stops = branch.stops.filter((id) => stations.has(id))
  const ids: StationId[] = []
  const calls: boolean[] = []
  if (stops.length === 0) return { ids, calls }

  const served = new Set(stops)
  const candidates = (branch.passes ?? [])
    .filter((id) => stations.has(id) && !served.has(id))
    .map((id) => ({ id, at: stations.get(id)![space] }))

  ids.push(stops[0])
  calls.push(true)

  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (a === b) continue
    for (const skipped of passedAlong(stations.get(a)![space], stations.get(b)![space], candidates)) {
      ids.push(skipped.id)
      calls.push(false)
    }
    ids.push(b)
    calls.push(true)
  }
  return { ids, calls }
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

  const served = new Set(stops)
  const passCandidates = (branch.passes ?? [])
    .filter((id) => stations.has(id) && !served.has(id))
    .map((id) => ({ id, at: stations.get(id)![space] }))

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

    // Stations this branch runs through without calling. They join the centreline as
    // ordinary vertices and carry no entry in `stopIndices`, which keeps them out of
    // the symbol layer while still bending the route through them.
    //
    // Each sub-segment takes the offset of the corridor it is actually in, so an
    // express weaving past a local stays the right distance from it the whole way.
    const from = stations.get(a)![space]
    const to = stations.get(b)![space]
    let prev = a
    for (const skipped of passedAlong(from, to, passCandidates)) {
      const subKey = segmentKey(prev, skipped.id)
      const subCanonical = network.offsets.get(subKey)?.get(line.id) ?? canonical
      points.push({ ...skipped.at })
      offsets.push(isForward(prev, skipped.id) ? subCanonical : -subCanonical)
      prev = skipped.id
    }
    const lastKey = segmentKey(prev, b)
    const lastCanonical = network.offsets.get(lastKey)?.get(line.id) ?? canonical
    const lastTravel = isForward(prev, b) ? lastCanonical : -lastCanonical

    points.push({ ...stations.get(b)![space] })
    offsets.push(lastTravel)
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
