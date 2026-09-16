/**
 * Choosing a station's symbol.
 *
 * Real transit maps do not draw every station the same way. A stop on one line is a
 * tick; a place where several lines meet is a filled interchange; and where several
 * lines run through side by side, the symbol becomes a BAR laid across the corridor,
 * spanning every parallel stroke, so one shape reads as one place.
 *
 * All of it is derived from the graph — nothing here is stored.
 */

import { modeById } from './defaults'
import { dist, norm, perp, rectHitsSegment, sub } from './geometry'
import {
  branchGeometry,
  isForward,
  segmentKey,
  stationMap,
  type Network,
  type Space,
} from './network'
import type {
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
    }
  | { kind: 'interchange'; radius: number }
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
function corridorAt(
  project: Project,
  network: Network,
  station: Station,
  space: Space,
): { dir: Vec2; parallel: number } | null {
  const neighbours = [...(network.neighbours.get(station.id) ?? [])]
  if (neighbours.length === 0) return null

  let bestKey: string | null = null
  let bestCount = 0
  for (const n of neighbours) {
    const key = segmentKey(station.id, n)
    const count = network.corridors.get(key)?.length ?? 0
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }
  if (!bestKey || bestCount < 2) {
    return { dir: { x: 1, y: 0 }, parallel: bestCount }
  }

  // Direction of the busiest corridor, measured toward the neighbour on it.
  const other = neighbours.find((n) => segmentKey(station.id, n) === bestKey)
  if (!other) return { dir: { x: 1, y: 0 }, parallel: bestCount }
  const target = project.stations.find((s) => s.id === other)
  if (!target) return { dir: { x: 1, y: 0 }, parallel: bestCount }

  const d = sub(target[space], station[space])
  if (dist(target[space], station[space]) < 1e-6) {
    return { dir: { x: 1, y: 0 }, parallel: bestCount }
  }
  return { dir: norm(d), parallel: bestCount }
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

  // Several lines running through side by side: one bar across the whole bundle.
  if (corridor && corridor.parallel > 1) {
    const spacing = project.style.corridorSpacing
    const widest = project.lines.reduce((max, l) => {
      if (l.hidden) return max
      const w = modeById(project.modes, l.mode).strokeWidth * project.style.strokeScale
      return Math.max(max, w)
    }, 0)
    const half = ((corridor.parallel - 1) * spacing) / 2 + widest / 2 + 2
    return {
      shape: {
        kind: 'bar',
        center: station[space],
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
    return { shape: { kind: 'interchange', radius: r * 1.45 }, terminus, lineCount: lines.length }
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
