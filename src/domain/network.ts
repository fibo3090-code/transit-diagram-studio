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
 * Which side of a segment a positive offset falls on.
 *
 * A corridor's offsets are ranks, and a rank only becomes a position once something
 * says which way is "up". That used to be the segment key's own direction, which is
 * `min(id)|max(id)` — decided by generated ids, and therefore arbitrary. Two adjacent
 * collinear segments could disagree about it, and every line in the bundle jumped to
 * the other side halfway along: the zigzag you see when a line is drawn as a row of
 * alternating dog-legs instead of a straight run.
 *
 * Tying it to geometry instead makes neighbouring segments of one run agree, whatever
 * ids they happen to carry. Rightward is positive; for a vertical segment, downward is.
 */
export function orientation(from: Vec2, to: Vec2): 1 | -1 {
  const dx = to.x - from.x
  if (Math.abs(dx) > 1e-9) return dx > 0 ? 1 : -1
  return to.y - from.y >= 0 ? 1 : -1
}

/** Where rank `i` of `n` parallel tracks sits, measured from the bundle's own middle. */
export function rankOffset(i: number, n: number, spacing: number): number {
  return (i - (n - 1) / 2) * spacing
}

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
  }

  // --- where each bundle sits across the track ------------------------------
  //
  // Ranks on their own are not enough. Centring every corridor on its own stations means
  // a bundle that gains a member pushes everybody sideways: where a third line merges in,
  // the two already running together each shift by half a spacing and come back after the
  // junction, which draws as a shallow S-bend in lines that are in fact dead straight.
  //
  // Real maps hold the lines that were already there and put the newcomer on the outside.
  // That is what this does: walk the corridors, and where two adjacent ones share lines,
  // shift the second so the shared lines stay where they were. The shift is snapped to
  // half a spacing so bundles stay on one lattice, and bounded so a long chain of merges
  // cannot walk a trunk off its own stations.
  const bundleShift = new Map<string, number>()
  {
    const corridorsAt = new Map<StationId, string[]>()
    for (const key of corridors.keys()) {
      const [a, b] = splitSegmentKey(key)
      for (const id of [a, b]) {
        const list = corridorsAt.get(id)
        if (list) list.push(key)
        else corridorsAt.set(id, [key])
      }
    }

    const keys = [...corridors.keys()].sort()
    const settled = new Set<string>()
    const limit = spacing * 2

    for (const seed of keys) {
      if (settled.has(seed)) continue
      settled.add(seed)
      bundleShift.set(seed, 0)
      const queue: string[] = [seed]

      while (queue.length > 0) {
        const cur = queue.shift()!
        const curLines = corridors.get(cur)!
        const curShift = bundleShift.get(cur)!
        const [a, b] = splitSegmentKey(cur)
        const near = new Set([...(corridorsAt.get(a) ?? []), ...(corridorsAt.get(b) ?? [])])

        for (const next of [...near].sort()) {
          if (settled.has(next)) continue
          const lines = corridors.get(next)!
          const shared = lines.filter((id) => curLines.includes(id))
          if (shared.length === 0) continue

          let sum = 0
          for (const id of shared) {
            sum +=
              rankOffset(curLines.indexOf(id), curLines.length, spacing) +
              curShift -
              rankOffset(lines.indexOf(id), lines.length, spacing)
          }
          const want = sum / shared.length
          const snapped = Math.round(want / (spacing / 2)) * (spacing / 2)
          bundleShift.set(next, Math.max(-limit, Math.min(limit, snapped)))
          settled.add(next)
          queue.push(next)
        }
      }
    }
  }

  for (const [key, ordered] of corridors) {
    const m = new Map<LineId, number>()
    const d = bundleShift.get(key) ?? 0
    ordered.forEach((id, i) => m.set(id, rankOffset(i, ordered.length, spacing) + d))
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
/**
 * Is `p` sitting on the segment a-b, rather than merely near it?
 *
 * Deliberately strict. A station a few units off an alignment is a separate place that
 * happens to be close; only one the line genuinely runs over should split its corridor.
 */
const ON_SEGMENT_TOLERANCE = 1.5

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-9) return false
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  if (t <= 1e-6 || t >= 1 - 1e-6) return false
  const px = a.x + dx * t
  const py = a.y + dy * t
  return Math.hypot(p.x - px, p.y - py) <= ON_SEGMENT_TOLERANCE
}

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

    // Falling between the ends is not the same as being on the line.
    //
    // `candidates` is the whole branch's worth, so a station genuinely sitting on one
    // segment is also offered to every other segment, and any of them whose projection
    // range happens to contain it would swallow it — dragging the centreline out to
    // that station and back as a spike across the map. The perpendicular distance is
    // what actually decides membership.
    const px = a.x + dx * t
    const py = a.y + dy * t
    if (Math.hypot(c.at.x - px, c.at.y - py) > ON_SEGMENT_TOLERANCE) continue

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

  // Declared pass-throughs, plus any station the branch simply runs over.
  //
  // The second half matters as much as the first, and it is easy to miss. A rail line
  // stopping every two kilometres and a tram stopping every five hundred metres can run
  // along the same street, and the rail line has ONE segment spanning four of the tram's.
  // Nothing then matches, neither knows it shares a corridor, both take offset zero, and
  // the train is drawn straight over the tram and through its stops. Treating a station
  // the line physically runs over as passed splits that long segment, and the two lines
  // find each other.
  const candidates = new Map<StationId, { id: StationId; at: Vec2 }>()
  for (const id of branch.passes ?? []) {
    if (stations.has(id) && !served.has(id)) {
      candidates.set(id, { id, at: stations.get(id)![space] })
    }
  }
  for (let i = 1; i < stops.length; i++) {
    const a = stations.get(stops[i - 1])?.[space]
    const b = stations.get(stops[i])?.[space]
    if (!a || !b) continue
    for (const [id, st] of stations) {
      if (served.has(id) || candidates.has(id)) continue
      if (onSegment(a, b, st[space])) candidates.set(id, { id, at: st[space] })
    }
  }

  const list = [...candidates.values()]
  ids.push(stops[0])
  calls.push(true)

  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (a === b) continue
    for (const skipped of passedAlong(stations.get(a)![space], stations.get(b)![space], list)) {
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

  // The SAME walk the corridor map was built from.
  //
  // These two used to segment the branch differently: corridors were keyed by every
  // sub-segment a pass-through creates, while the drawing still asked for the long
  // stop-to-stop key. That key is in no corridor, so every lookup missed and fell back
  // to offset zero — a rail line drawn straight down the middle of the tram it was
  // supposed to be running beside. One walk, one segmentation, no way to disagree.
  const { ids, calls } = branchSequence(branch, stations, space)
  if (ids.length < 2) return null

  const points: Vec2[] = []
  const offsets: number[] = []
  const stopIndices: number[] = []
  const kept: StationId[] = []

  // Bends belong to the stop-to-stop pair the author drew them on, which may now span
  // several sub-segments. They are emitted on the first one of that pair.
  const bendsPending = new Set<string>()
  for (let i = 1; i < stops.length; i++) bendsPending.add(segmentKey(stops[i - 1], stops[i]))

  points.push({ ...stations.get(ids[0])![space] })
  stopIndices.push(0)
  kept.push(ids[0])

  /** The stop-to-stop pair a sub-segment belongs to, for finding its bends. */
  let servedFrom = ids[0]

  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1]
    const b = ids[i]
    if (a === b) continue

    const from = stations.get(a)![space]
    const to = stations.get(b)![space]
    const canonical = network.offsets.get(segmentKey(a, b))?.get(line.id) ?? 0
    const travel = orientation(from, to) * canonical

    const servedKey = segmentKey(servedFrom, b)
    if (bendsPending.has(servedKey)) {
      bendsPending.delete(servedKey)
      // Bends are stored in the key's own (id) order, so THIS one still asks about
      // ids: it is about which end of the stored array comes first, not about which
      // side of the line an offset falls on.
      const stored = line.bends[servedKey] ?? []
      for (const bend of isForward(servedFrom, b) ? stored : [...stored].reverse()) {
        points.push({ ...bend[space] })
        offsets.push(travel)
      }
    }

    points.push({ ...to })
    offsets.push(travel)

    if (calls[i]) {
      stopIndices.push(points.length - 1)
      kept.push(b)
      servedFrom = b
    }
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

/**
 * Every corridor where these two lines run side by side, reachable from this one.
 *
 * Reordering has to work on a run, not a segment. Two lines that share twelve segments
 * are, to a reader, one pair of parallel tracks — swapping them over one segment and not
 * the other eleven is never what anyone meant, and doing it twelve times by hand from a
 * panel is why the feature went unused.
 *
 * The walk follows stations, and only steps into corridors that carry BOTH lines: where
 * one of them leaves, the question of which side it is on stops existing.
 */
export function sharedRun(network: Network, from: SegmentKey | string, a: LineId, b: LineId): string[] {
  const has = (key: string) => {
    const ids = network.corridors.get(key)
    return !!ids && ids.includes(a) && ids.includes(b)
  }
  if (!has(from)) return []

  const byStation = new Map<StationId, string[]>()
  for (const key of network.corridors.keys()) {
    if (!has(key)) continue
    for (const id of splitSegmentKey(key)) {
      const list = byStation.get(id)
      if (list) list.push(key)
      else byStation.set(id, [key])
    }
  }

  const seen = new Set<string>([from])
  const queue = [from as string]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const end of splitSegmentKey(cur)) {
      for (const next of byStation.get(end) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return [...seen].sort()
}

/**
 * The corridor orders to write so that `lineId` moves one place across its bundle.
 *
 * Returned rather than applied, so the decision is pure and testable and the store stays
 * a thin wrapper around it. `scope: 'here'` limits the change to one segment, which is
 * how you draw a deliberate crossover; the default carries it along the whole run, which
 * is what someone means by "put the red line above the blue one".
 */
export function swapAcrossRun(
  network: Network,
  key: SegmentKey | string,
  lineId: LineId,
  delta: -1 | 1,
  scope: 'run' | 'here' = 'run',
): Record<string, LineId[]> {
  const here = network.corridors.get(key)
  if (!here) return {}
  const from = here.indexOf(lineId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= here.length) return {}
  const other = here[to]

  const keys = scope === 'here' ? [key as string] : sharedRun(network, key, lineId, other)
  const out: Record<string, LineId[]> = {}
  for (const k of keys.length > 0 ? keys : [key as string]) {
    const order = [...(network.corridors.get(k) ?? [])]
    const i = order.indexOf(lineId)
    const j = order.indexOf(other)
    if (i < 0 || j < 0) continue
    order[i] = other
    order[j] = lineId
    out[k] = order
  }
  return out
}

/**
 * Which stops a branch calls at, expressed as a pattern rather than a list.
 *
 * Real networks describe services this way — all-stops, every other one, the same
 * pattern as the service before it — and the alternative is clicking through forty
 * stations twice and getting one wrong. `alternate-a` and `alternate-b` are the Chicago
 * skip-stop pair: between them they serve everything, and neither serves it all.
 *
 * Ends always call. A service cannot terminate somewhere it runs through.
 */
export type CallingMask =
  | 'all'
  | 'alternate-a'
  | 'alternate-b'
  | { calls: StationId[] }

export function applyCallingMask(
  branch: Branch,
  stations: Map<StationId, Station>,
  mask: CallingMask,
  space: Space = 'schematic',
): { stops: StationId[]; passes: StationId[] } | null {
  const { ids } = branchSequence(branch, stations, space)
  if (ids.length < 2) return null

  const wanted = typeof mask === 'object' ? new Set(mask.calls) : null
  const stops: StationId[] = []
  const passes: StationId[] = []

  ids.forEach((id, i) => {
    const end = i === 0 || i === ids.length - 1
    const calls =
      end ||
      (mask === 'all'
        ? true
        : mask === 'alternate-a'
          ? i % 2 === 0
          : mask === 'alternate-b'
            ? i % 2 === 1
            : wanted!.has(id))
    if (calls) {
      if (stops[stops.length - 1] !== id) stops.push(id)
    } else if (!passes.includes(id)) {
      passes.push(id)
    }
  })

  if (stops.length < 2) return null
  // A station cannot be both; a call anywhere on the run wins.
  return { stops, passes: passes.filter((id) => !stops.includes(id)) }
}
