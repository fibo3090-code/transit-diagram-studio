/**
 * Choosing a station's symbol.
 *
 * Real transit maps do not draw every station the same way. A stop on one line is a
 * tick; a place where several lines meet is a filled interchange; and where several
 * lines STOP side by side, the symbol becomes a BAR laid across those tracks, so one
 * shape reads as one place.
 *
 * Only the lines that actually call are counted. A line running through without
 * stopping keeps its stroke unbroken and gets no part of the symbol, which is the
 * whole visual point of an express.
 *
 * All of it is derived from the graph — nothing here is stored.
 */

import { modeById } from './defaults'
import {
  add,
  closestOnSegment,
  dist,
  mul,
  norm,
  offsetPolyline,
  perp,
  rectHitsSegment,
  sub,
} from './geometry'
import {
  branchGeometry,
  isForward,
  orientation,
  segmentKey,
  stationMap,
  type Network,
  type Space,
} from './network'
import type {
  LineId,
  Project,
  Station,
  StationId,
  StationSymbol as StationSymbolKind,
  Vec2,
} from './types'

export type SymbolShape =
  | {
      kind: 'plain'
      radius: number
      color: string
      filled: boolean
      /** From the line's mode, so rail reads differently from tram at a glance. */
      symbol: StationSymbolKind
      /** Direction across the track, for a tick mark. */
      across: Vec2
      /** Nudge onto the track that actually stops here, when an express runs beside. */
      shift: Vec2
    }
  | { kind: 'interchange'; radius: number; shift: Vec2 }
  /**
   * One mark per calling service, each on its own track.
   *
   * Used where a corridor carries lines that do NOT all stop. A single shared symbol
   * cannot express that: whatever shape is drawn, it sits across tracks belonging to
   * services that run straight past, and reads as "everything stops here".
   *
   * This is the New York convention, and the instruction the MTA actually gives its
   * riders is the giveaway — check that your service has a dot at the station. The dot
   * belongs to the service, not to the place.
   */
  | {
      kind: 'perService'
      radius: number
      marks: { at: Vec2; color: string; line: LineId }[]
      /**
       * A thin tie joining the marks, so the group still reads as ONE place.
       *
       * Without it a junction where something runs past dissolves into loose dots.
       * Linked dots are how transfer stations are drawn on the New York map, and the
       * two devices answer different questions: the tie says "this is one station",
       * each dot says "this service stops at it".
       */
      tie: { from: Vec2; to: Vec2 } | null
      /** The tracks that run past, so the renderer can leave them alone. */
      passing: number
    }
  | { kind: 'bar'; center: Vec2; dir: Vec2; halfLength: number; thickness: number }
  | { kind: 'orphan'; radius: number }

export interface StationSymbol {
  shape: SymbolShape
  /** True when at least one line ends here. */
  terminus: boolean
  lineCount: number
}

/**
 * Average direction of the corridors meeting at a station, and the widest parallel
 * bundle running through it. The bundle is what a bar has to span.
 */
interface CorridorAtStation {
  dir: Vec2
  /** How many of the corridor's lines actually CALL here. */
  parallel: number
  /** How many run past without calling. */
  passing: number
  /** Lateral offset of the middle of the calling tracks, in diagram units. */
  shift: number
  /** Half the lateral spread of the calling tracks. */
  spread: number
  /** Each calling line and the track it sits on, in canonical direction. */
  offsets: { lineId: LineId; offset: number }[]
  /** True when this station is the far end of the segment key, so offsets mirror. */
  mirrored: boolean
}

/**
 * The busiest corridor through a station, and where the tracks that stop there sit
 * within it.
 *
 * The distinction matters as soon as an express exists. A corridor may carry four
 * lines while only two of them call, and the stop belongs to those two: it is drawn on
 * their tracks, spanning only them, with the express running past untouched. Counting
 * every line in the corridor instead put a bar right across the express as well, which
 * reads as "everything stops here" — the opposite of what an express is.
 */
function corridorAt(
  project: Project,
  network: Network,
  station: Station,
  space: Space,
): CorridorAtStation | null {
  const neighbours = [...(network.neighbours.get(station.id) ?? [])]
  if (neighbours.length === 0) return null

  const calling = new Set(network.linesAtStation.get(station.id) ?? [])
  const spacing = project.style.corridorSpacing

  let bestKey: string | null = null
  let bestCount = 0
  for (const n of neighbours) {
    const key = segmentKey(station.id, n)
    // Rank corridors by how many lines stop here, not by how many pass through.
    const count = (network.corridors.get(key) ?? []).filter((id) => calling.has(id)).length
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }

  const flat = (parallel: number, shift = 0, spread = 0): CorridorAtStation => ({
    dir: { x: 1, y: 0 },
    parallel,
    passing: 0,
    shift,
    spread,
    offsets: [],
    mirrored: false,
  })

  if (!bestKey) return flat(bestCount)

  // Where the calling tracks sit across the bundle, and how many run past.
  const offsets = network.offsets.get(bestKey)
  const inCorridor = network.corridors.get(bestKey) ?? []
  const callingOffsets = inCorridor
    .filter((id) => calling.has(id))
    .map((id) => ({ lineId: id, offset: offsets?.get(id) ?? 0 }))
  const passing = inCorridor.length - callingOffsets.length
  const mine = callingOffsets.map((o) => o.offset)
  const lo = mine.length ? Math.min(...mine) : 0
  const hi = mine.length ? Math.max(...mine) : 0
  const shift = mine.length ? (lo + hi) / 2 : 0
  const spread = mine.length ? (hi - lo) / 2 : 0
  void spacing

  // Direction of that corridor, measured toward the neighbour on it.
  const other = neighbours.find((n) => segmentKey(station.id, n) === bestKey)
  const target = other ? project.stations.find((s) => s.id === other) : undefined
  const usable =
    !!other && !!target && dist(target[space], station[space]) >= 1e-6

  if (!usable) {
    return { ...flat(bestCount, shift, spread), passing, offsets: callingOffsets }
  }

  // Same geometric convention the strokes use.
  const mirrored = orientation(station[space], target![space]) < 0
  return {
    dir: norm(sub(target![space], station[space])),
    parallel: bestCount,
    passing,
    shift: mirrored ? -shift : shift,
    spread,
    offsets: callingOffsets,
    mirrored,
  }
}

/**
 * Every line as it is actually drawn, memoised against the network it came from.
 *
 * A mark's position is worked out from corridor offsets, which is right in the middle of
 * a straight run and wrong wherever the stroke does something else. Where a line turns
 * at a station, the mitred corner of its offset polyline sits away from the station by
 * as much as the offset itself; where it merges, its two corridors can put it at
 * different offsets. Both leave the dot floating beside the track it claims to be on.
 *
 * So the last word belongs to the drawing: a mark is snapped onto the nearest point of
 * the stroke it names. The layout logic still decides which side and which slot, which
 * is what keeps marks tidy and evenly spread; this only removes the gap.
 */
const drawnCache = new WeakMap<Network, Map<Space, Map<LineId, Vec2[][]>>>()

function drawnPaths(project: Project, network: Network, space: Space): Map<LineId, Vec2[][]> {
  let bySpace = drawnCache.get(network)
  if (!bySpace) drawnCache.set(network, (bySpace = new Map()))
  const hit = bySpace.get(space)
  if (hit) return hit

  const stations = stationMap(project)
  const out = new Map<LineId, Vec2[][]>()
  for (const line of project.lines) {
    if (line.hidden) continue
    const paths: Vec2[][] = []
    for (const branch of line.branches) {
      const g = branchGeometry(project, network, line, branch, space, stations)
      if (g) paths.push(offsetPolyline(g.points, g.offsets))
    }
    if (paths.length > 0) out.set(line.id, paths)
  }
  bySpace.set(space, out)
  return out
}

/** `at` is relative to the station; the returned point is too. */
function ontoItsStroke(
  project: Project,
  network: Network,
  space: Space,
  station: Station,
  lineId: LineId,
  at: Vec2,
): Vec2 {
  const paths = drawnPaths(project, network, space).get(lineId)
  if (!paths) return at
  const from = add(station[space], at)
  let best: Vec2 | null = null
  let bestDist = Infinity
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const q = closestOnSegment(from, path[i], path[i + 1])
      const d = dist(from, q)
      if (d < bestDist) {
        bestDist = d
        best = q
      }
    }
  }
  return best ? sub(best, station[space]) : at
}

/**
 * One mark per calling service, each on the track it uses at this station.
 *
 * Walks every corridor meeting the station rather than only the busiest, so a line
 * arriving from the north and a line arriving from the west each get a dot on their
 * own stroke. Anything present in a corridor here but not calling is counted as
 * passing, which is what switches the symbol to this form in the first place.
 */
function serviceMarks(
  project: Project,
  network: Network,
  station: Station,
  space: Space,
): {
  marks: { at: Vec2; color: string; line: LineId }[]
  passing: number
  /** Where the tie has to reach to touch every calling service. */
  reach: { from: Vec2; to: Vec2 } | null
} {
  const calling = new Set(network.linesAtStation.get(station.id) ?? [])
  const neighbours = [...(network.neighbours.get(station.id) ?? [])]

  const placed = new Map<LineId, Vec2>()
  const runsPast = new Set<LineId>()

  // Marks are only laid out along corridors that actually carry something running past.
  //
  // A service arriving on a corridor where everything stops has no need of its own dot,
  // and giving it one is actively harmful: its slot is measured from a different axis,
  // so the two marks land a few units apart and overlap. Those services are covered by
  // the tie instead, which is extended to reach the middle where their stroke runs.
  // A line can reach a station on two different corridors and sit at a different
  // offset in each — wider where more lines run alongside. Whichever is visited first
  // used to win, and "first" depended on generated ids, so the same map drew its marks
  // in different places on different loads.
  //
  // Take the busiest corridor, deterministically. It is the main bundle, the offsets
  // there are the widest, and the choice no longer varies between runs.
  const ordered = [...neighbours].sort((a, b) => {
    const ca = (network.corridors.get(segmentKey(station.id, a)) ?? []).length
    const cb = (network.corridors.get(segmentKey(station.id, b)) ?? []).length
    if (ca !== cb) return cb - ca
    return segmentKey(station.id, a) < segmentKey(station.id, b) ? -1 : 1
  })

  for (const n of ordered) {
    const key = segmentKey(station.id, n)
    const inCorridor = network.corridors.get(key) ?? []
    if (inCorridor.length === 0) continue

    const skipping = inCorridor.filter((id) => !calling.has(id))
    for (const id of skipping) runsPast.add(id)
    if (skipping.length === 0) continue

    const target = project.stations.find((s) => s.id === n)
    if (!target || dist(target[space], station[space]) < 1e-6) continue
    const dir = norm(sub(target[space], station[space]))
    const across = perp(dir)
    // Which side a positive offset falls on is decided geometrically, exactly as the
    // stroke decides it. Anything else and the dot sits opposite its own track.
    const mirrored = orientation(station[space], target[space]) < 0
    const offsets = network.offsets.get(key)

    for (const id of inCorridor) {
      if (!calling.has(id) || placed.has(id)) continue
      const o = offsets?.get(id) ?? 0
      placed.set(id, mul(across, mirrored ? -o : o))
    }
  }

  // A service that stops here but arrives on a different corridor has no slot in this
  // bundle, so giving it a dot of its own would put two marks a few units apart and
  // they would sit on top of each other. It is covered by the tie instead: the tie is
  // extended to the middle, where that service's stroke runs, so the station visibly
  // touches it without a second dot competing for the same space.
  const unplaced = [...calling].filter((id) => !placed.has(id))

  const order = project.lines.map((l) => l.id)
  const inOrder = [...placed.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))

  // Snapping a mark onto its stroke fixes a dot floating beside a corner, but where two
  // strokes converge at the station it can push two dots into one another — and two
  // marks on top of each other is a worse lie than one slightly off its track. So a snap
  // is taken only when it keeps its distance; otherwise the laid-out slot stands.
  const apart = project.style.corridorSpacing * 0.9
  const taken: Vec2[] = []
  const marks = inOrder.map(([id, at]) => {
    const snapped = ontoItsStroke(project, network, space, station, id, at)
    const clear = taken.every((q) => dist(q, snapped) >= apart)
    const chosen = clear ? snapped : at
    taken.push(chosen)
    return {
      at: chosen,
      color: project.lines.find((l) => l.id === id)?.color ?? project.style.foreground,
      line: id,
    }
  })

  let reach: { from: Vec2; to: Vec2 } | null = null
  const pts = marks.map((m) => m.at)
  if (unplaced.length > 0) pts.push({ x: 0, y: 0 })
  if (pts.length > 1) {
    let a = pts[0]
    let b = pts[0]
    let best = -1
    for (const q of pts) {
      for (const w of pts) {
        const d = dist(q, w)
        if (d > best) {
          best = d
          a = q
          b = w
        }
      }
    }
    if (best > 0.5) reach = { from: a, to: b }
  }

  return { marks, passing: runsPast.size, reach }
}

export function stationSymbol(
  project: Project,
  network: Network,
  station: Station,
  space: Space,
): StationSymbol {
  const lines = network.linesAtStation.get(station.id) ?? []
  const r = project.style.stationRadius
  const terminus = lines.some((id) => network.terminiByLine.get(id)?.has(station.id))

  if (lines.length === 0) {
    return { shape: { kind: 'orphan', radius: r * 0.7 }, terminus: false, lineCount: 0 }
  }

  const corridor = corridorAt(project, network, station, space)

  // The symbol sits on the tracks that stop here, which is not always the middle of
  // the bundle: an express running alongside shifts the calling tracks to one side.
  const across = corridor ? mul(perp(corridor.dir), corridor.shift) : { x: 0, y: 0 }
  const centre = add(station[space], across)

  // Where anything runs past without calling, every calling service gets its own mark
  // on its own track and the rest are left clean. See `perService`.
  //
  // Marks are gathered across ALL the corridors meeting here, not just the busiest one:
  // the lines that stop at a junction arrive from different directions, and each needs
  // its dot on the track it actually uses.
  const service = serviceMarks(project, network, station, space)
  if (service.passing > 0 && service.marks.length > 0) {
    // Marks are one corridor-spacing apart, so they have to be small enough to sit
    // beside each other. Half the spacing, less a hair, is the largest that can never
    // collide however tight the corridor is set.
    const spacing = project.style.corridorSpacing
    return {
      shape: {
        kind: 'perService',
        radius: Math.min(r * 0.78, spacing * 0.46),
        passing: service.passing,
        marks: service.marks,
        tie: service.reach,
      },
      terminus,
      lineCount: lines.length,
    }
  }

  // Several lines CALLING side by side: one bar across just those.
  if (corridor && corridor.parallel > 1) {
    const widest = project.lines.reduce((max, l) => {
      if (l.hidden) return max
      const w = modeById(project.modes, l.mode).strokeWidth * project.style.strokeScale
      return Math.max(max, w)
    }, 0)
    const half = corridor.spread + widest / 2 + 2
    return {
      shape: {
        kind: 'bar',
        center: centre,
        // The bar lies ACROSS the corridor, so it runs along the perpendicular.
        dir: perp(corridor.dir),
        halfLength: half,
        thickness: r * 1.5,
      },
      terminus,
      lineCount: lines.length,
    }
  }

  if (lines.length > 1) {
    return {
      shape: { kind: 'interchange', radius: r * 1.45, shift: across },
      terminus,
      lineCount: lines.length,
    }
  }

  const only = project.lines.find((l) => l.id === lines[0])
  const color = only?.color ?? project.style.foreground
  const mode = only ? modeById(project.modes, only.mode) : project.modes[0]
  return {
    shape: {
      kind: 'plain',
      radius: r,
      color,
      filled: terminus,
      symbol: mode?.stationSymbol ?? 'circle',
      across: corridor ? perp(corridor.dir) : { x: 0, y: 1 },
      shift: across,
    },
    terminus,
    lineCount: 1,
  }
}

// ---------------------------------------------------------------------------
// Route badges
// ---------------------------------------------------------------------------

export interface LineBadge {
  lineId: string
  text: string
  color: string
  at: Vec2
}

/**
 * A badge at each end of each line, pushed out along the direction the route arrives
 * from — the route bullet real maps put at a terminus so you can name a line without
 * hunting for a legend.
 */
export function lineBadges(
  project: Project,
  network: Network,
  space: Space,
  distance = 26,
): LineBadge[] {
  const out: LineBadge[] = []
  const byId = new Map(project.stations.map((s) => [s.id, s]))

  const stations = stationMap(project)
  const track: [Vec2, Vec2][] = []
  for (const line of project.lines) {
    if (line.hidden) continue
    for (const branch of line.branches) {
      const geom = branchGeometry(project, network, line, branch, space, stations)
      if (!geom) continue
      for (let i = 0; i < geom.points.length - 1; i++) {
        track.push([geom.points[i], geom.points[i + 1]])
      }
    }
  }

  for (const line of project.lines) {
    if (line.hidden || !line.name) continue
    const termini = network.terminiByLine.get(line.id)
    if (!termini) continue

    // Neighbours ON THIS LINE only. The network-wide adjacency would mix in other
    // lines' directions and push the badge somewhere this route never goes — usually
    // straight onto another line's track.
    const ownNeighbours = new Map<StationId, StationId[]>()
    for (const branch of line.branches) {
      for (let i = 0; i < branch.stops.length; i++) {
        const here = branch.stops[i]
        const list = ownNeighbours.get(here) ?? []
        if (i > 0) list.push(branch.stops[i - 1])
        if (i < branch.stops.length - 1) list.push(branch.stops[i + 1])
        ownNeighbours.set(here, list)
      }
    }

    for (const id of termini) {
      const station = byId.get(id)
      if (!station) continue
      const neighbours = (ownNeighbours.get(id) ?? [])
        .map((n) => byId.get(n))
        .filter((s): s is Station => !!s)
      if (neighbours.length === 0) continue

      // Average the directions the neighbours sit in, then go the opposite way.
      let ax = 0
      let ay = 0
      for (const n of neighbours) {
        const d = norm(sub(n[space], station[space]))
        ax += d.x
        ay += d.y
      }
      const away = norm({ x: -ax, y: -ay })
      const base = dist({ x: 0, y: 0 }, away) < 0.01 ? { x: -1, y: 0 } : away

      // A line that ends partway along another line's route would otherwise drop its
      // bullet straight onto that track. Rotate away from the route until the badge
      // sits in clear space, and fall back to the natural direction if nothing is.
      const fs = project.style.fontSize * 0.86
      const w = Math.max(fs * 1.5, line.name.length * fs * 0.62) + fs * 0.7
      const h = fs * 1.7
      const baseAngle = Math.atan2(base.y, base.x)

      let at = {
        x: station[space].x + base.x * distance,
        y: station[space].y + base.y * distance,
      }
      for (const turn of [0, 45, -45, 90, -90, 135, -135, 180]) {
        const a = baseAngle + (turn * Math.PI) / 180
        const candidate = {
          x: station[space].x + Math.cos(a) * distance,
          y: station[space].y + Math.sin(a) * distance,
        }
        const rect = { x: candidate.x - w / 2, y: candidate.y - h / 2, w, h }
        const clear = !track.some(
          ([q1, q2]) =>
            (dist(candidate, q1) < 200 || dist(candidate, q2) < 200) &&
            rectHitsSegment(rect, q1, q2),
        )
        if (clear) {
          at = candidate
          break
        }
      }

      out.push({ lineId: line.id, text: line.name, color: line.color, at })
    }
  }
  return out
}

/**
 * Direction of the line through a station, used to orient a tick mark so it sits
 * across the track rather than along it.
 */
export function tickDirection(
  project: Project,
  network: Network,
  station: Station,
  space: Space,
): Vec2 {
  const c = corridorAt(project, network, station, space)
  return c ? perp(c.dir) : { x: 0, y: 1 }
}

/** Which side of a segment a line sits on, for drawing bend handles in the right place. */
export function segmentOffsetFor(
  network: Network,
  lineId: string,
  a: StationId,
  b: StationId,
): number {
  const key = segmentKey(a, b)
  const canonical = network.offsets.get(key)?.get(lineId as never) ?? 0
  return isForward(a, b) ? canonical : -canonical
}


// ---------------------------------------------------------------------------
// Corridor levels, for snapping
// ---------------------------------------------------------------------------

export interface CorridorLevel {
  origin: Vec2
  dir: Vec2
  /** 0 for a real line in the bundle, ±1 for the pass-by track just outside it. */
  outside: number
}

/**
 * The parallel tracks running through a station: one per line in its busiest bundle,
 * plus one just beyond each edge.
 *
 * Snapping to an inner level puts a route exactly where one of the existing lines runs;
 * snapping to an outer one runs it alongside the whole bundle, which is how a map shows
 * a service passing a stop without calling at it. Without these, the only thing to snap
 * to at a multi-line stop was its centre — the middle of the bundle, and almost never
 * the track anyone meant.
 */
export function stationLevels(
  project: Project,
  network: Network,
  station: Station,
  space: Space,
): CorridorLevel[] {
  const c = corridorAt(project, network, station, space)
  if (!c) return []

  const count = Math.max(1, c.parallel)
  const spacing = project.style.corridorSpacing
  const n = perp(c.dir)
  const at = station[space]
  const out: CorridorLevel[] = []

  for (let i = -1; i <= count; i++) {
    const off = (i - (count - 1) / 2) * spacing
    out.push({
      origin: { x: at.x + n.x * off, y: at.y + n.y * off },
      dir: c.dir,
      outside: i < 0 ? -1 : i >= count ? 1 : 0,
    })
  }
  return out
}
