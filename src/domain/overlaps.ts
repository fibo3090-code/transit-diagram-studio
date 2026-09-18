/**
 * Does the drawing say what the network means?
 *
 * Station symbols and line strokes are produced by different code paths — one derives
 * marks from the graph, the other offsets polylines through a corridor — and nothing
 * made them agree. They only have to agree in one respect, but it is the respect that
 * carries the meaning:
 *
 *   a mark must sit ON the stroke of every service that stops there, and
 *   must NOT touch the stroke of a service that runs past.
 *
 * Get that wrong and the map states the opposite of the timetable. An express whose
 * stroke passes under a station dot reads as stopping; a local whose dot has drifted off
 * its own track reads as not stopping.
 *
 * This module measures both, plus marks colliding with each other, against the same
 * geometry the renderer draws. It is used by the tests and by the visual lab, so a
 * regression is caught by a failing check rather than by someone noticing later.
 */

import { modeById } from './defaults'
import { dist, distToSegment, offsetPolyline } from './geometry'
import {
  branchGeometry,
  buildNetwork,
  segmentKey,
  stationMap,
  type Network,
  type Space,
} from './network'
import { stationSymbol } from './symbols'
import type { LineId, Project, Station, StationId, Vec2 } from './types'

export type OverlapKind =
  /** Two marks at one station drawn on top of each other. */
  | 'marks-collide'
  /** A mark sits on the stroke of a service that does not stop there. */
  | 'mark-on-passing-line'
  /** A calling service's mark is nowhere near that service's own stroke. */
  | 'mark-off-its-line'

export interface Overlap {
  kind: OverlapKind
  station: StationId
  stationName: string
  /** The line the finding is about, where there is one. */
  line?: LineId
  lineName?: string
  other?: string
  /** How badly, in diagram units. Larger is worse. */
  amount: number
  /**
   * True when the offending line shares a corridor with the station — it runs ALONGSIDE
   * what stops here. That is the renderer's fault: parallel offsets exist precisely so
   * the two do not collide.
   *
   * False when the line merely crosses. Nothing the renderer does can fix that; the two
   * genuinely occupy the same point, and the layout has to move.
   */
  alongside?: boolean
}

interface Drawn {
  id: LineId
  name: string
  width: number
  /** Drawn centrelines, already offset into their corridor position. */
  paths: Vec2[][]
}

/** Every line as the renderer actually draws it. */
function drawnLines(project: Project, network: Network, space: Space): Drawn[] {
  const stations = stationMap(project)
  const out: Drawn[] = []
  for (const line of project.lines) {
    if (line.hidden) continue
    const width = modeById(project.modes, line.mode).strokeWidth * project.style.strokeScale
    const paths: Vec2[][] = []
    for (const branch of line.branches) {
      const geom = branchGeometry(project, network, line, branch, space, stations)
      if (!geom) continue
      paths.push(offsetPolyline(geom.points, geom.offsets))
    }
    if (paths.length > 0) out.push({ id: line.id, name: line.name, width, paths })
  }
  return out
}

/** Shortest distance from a point to any segment of a drawn line. */
function distanceTo(line: Drawn, p: Vec2): number {
  let best = Infinity
  for (const path of line.paths) {
    for (let i = 0; i < path.length - 1; i++) {
      best = Math.min(best, distToSegment(p, path[i], path[i + 1]))
    }
  }
  return best
}

/** Absolute positions of the marks a station draws, with the line each belongs to. */
function marksOf(
  project: Project,
  network: Network,
  station: Station,
  space: Space,
): { at: Vec2; radius: number; line?: LineId }[] {
  const sym = stationSymbol(project, network, station, space)
  const base = station[space]
  const shape = sym.shape

  if (shape.kind === 'perService') {
    // Each mark names its own line. Pairing marks with the station's calling lines by
    // position looks equivalent and is not: a service that arrives on a corridor where
    // everything stops gets no mark of its own, so the two lists fall out of step and
    // every mark after the gap is checked against the wrong line's track.
    return shape.marks.map((m) => ({
      at: { x: base.x + m.at.x, y: base.y + m.at.y },
      radius: shape.radius,
      line: m.line,
    }))
  }
  if (shape.kind === 'interchange') {
    return [{ at: { x: base.x + shape.shift.x, y: base.y + shape.shift.y }, radius: shape.radius }]
  }
  if (shape.kind === 'plain') {
    return [{ at: { x: base.x + shape.shift.x, y: base.y + shape.shift.y }, radius: shape.radius }]
  }
  if (shape.kind === 'bar') {
    // A bar spans its calling tracks; treated as one wide mark at its centre.
    return [{ at: shape.center, radius: shape.halfLength }]
  }
  return []
}

/**
 * Every place the drawing contradicts the network.
 *
 * `tolerance` is how much touching counts as touching: strokes and marks are drawn with
 * anti-aliased edges, and a fraction of a unit of contact is not a misreading.
 */
export function findOverlaps(
  project: Project,
  space: Space = 'schematic',
  tolerance = 0.75,
  existing?: Network,
): Overlap[] {
  // The caller usually has one already; building a second is pure waste on a map with
  // a couple of hundred stations.
  const network = existing ?? buildNetwork(project)
  const lines = drawnLines(project, network, space)
  const byId = new Map(lines.map((l) => [l.id, l]))
  const found: Overlap[] = []

  for (const station of project.stations) {
    const calling = new Set(network.linesAtStation.get(station.id) ?? [])
    if (calling.size === 0) continue

    const marks = marksOf(project, network, station, space)
    if (marks.length === 0) continue

    // Running ALONGSIDE means sharing a corridor with something that stops here —
    // two strokes side by side, which parallel offsets are supposed to keep apart.
    // Sharing merely an incident corridor is not enough: a line crossing the station
    // has a corridor here too, and nothing the renderer does will separate it from a
    // stop sitting on the crossing point.
    const inCorridors = new Set<LineId>()
    for (const n of network.neighbours.get(station.id) ?? []) {
      const ids = network.corridors.get(segmentKey(station.id, n)) ?? []
      if (!ids.some((id) => calling.has(id))) continue
      for (const id of ids) inCorridors.add(id)
    }

    // --- a mark must not sit on a line that runs past --------------------
    for (const mark of marks) {
      for (const line of lines) {
        if (calling.has(line.id)) continue
        const gap = distanceTo(line, mark.at) - (mark.radius + line.width / 2)
        if (gap < -tolerance) {
          found.push({
            kind: 'mark-on-passing-line',
            station: station.id,
            stationName: station.name,
            line: line.id,
            lineName: line.name,
            amount: -gap,
            alongside: inCorridors.has(line.id),
          })
        }
      }
    }

    // --- a calling service's mark must sit on its own stroke -------------
    for (const mark of marks) {
      if (!mark.line) continue
      const own = byId.get(mark.line)
      if (!own) continue
      const gap = distanceTo(own, mark.at) - own.width / 2
      if (gap > mark.radius + tolerance) {
        found.push({
          kind: 'mark-off-its-line',
          station: station.id,
          stationName: station.name,
          line: own.id,
          lineName: own.name,
          amount: gap,
        })
      }
    }

    // --- marks must not be drawn on top of each other --------------------
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const need = marks[i].radius + marks[j].radius
        const have = dist(marks[i].at, marks[j].at)
        if (have < need - tolerance) {
          found.push({
            kind: 'marks-collide',
            station: station.id,
            stationName: station.name,
            amount: need - have,
          })
        }
      }
    }
  }

  return found.sort((a, b) => b.amount - a.amount)
}

/** One line per finding, for a test failure or the lab. */
export function describeOverlap(o: Overlap): string {
  switch (o.kind) {
    case 'mark-on-passing-line':
      return o.alongside
        ? `${o.stationName}: the mark sits on ${o.lineName}, which runs alongside without stopping (by ${o.amount.toFixed(1)})`
        : `${o.stationName}: ${o.lineName} crosses here without stopping, under the symbol (by ${o.amount.toFixed(1)})`
    case 'mark-off-its-line':
      return `${o.stationName}: ${o.lineName} stops here but its mark is ${o.amount.toFixed(1)} off its own track`
    case 'marks-collide':
      return `${o.stationName}: two marks overlap by ${o.amount.toFixed(1)}`
  }
}
