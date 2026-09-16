/**
 * Journey planning over the network graph.
 *
 * The search runs over (station, line) states rather than plain stations, because the
 * cost of a journey is not just how far you go — it is how many times you change. A
 * plain station graph cannot tell "stay on this train" apart from "get off and wait for
 * another one", so it happily returns four-change routes that no passenger would take.
 *
 * Costs are in stops, not pixels: a diagram is topological, and the distance between two
 * dots on it means nothing. An interchange is priced at several stops' worth of
 * inconvenience, which is roughly how journey planners weigh it.
 */

import { allStopsOfLine, type Network } from './network'
import type { LineId, Project, StationId } from './types'

export interface RoutingCosts {
  /** Per stop travelled. */
  ride: number
  /** Changing line within one station. */
  interchange: number
  /** Walking between two separate stations on an out-of-station link. */
  transfer: number
}

export const DEFAULT_COSTS: RoutingCosts = {
  ride: 1,
  interchange: 4,
  transfer: 6,
}

export interface RouteLeg {
  /** Null means walking an out-of-station interchange. */
  lineId: LineId | null
  /** Stations in order, including both ends of the leg. */
  stops: StationId[]
}

export interface Route {
  legs: RouteLeg[]
  /** Stations passed through, in order, without duplicates at leg joins. */
  path: StationId[]
  stopCount: number
  interchanges: number
  walks: number
}

/** How the search identifies a position: standing at a station, on a given line. */
const WALK = '~walk'
const key = (station: StationId, line: string) => `${station}\u0000${line}`

interface Node {
  station: StationId
  line: string
  cost: number
  prev: string | null
}

/**
 * Cheapest journey from `from` to `to`, or null if the two are not connected.
 *
 * A plain array scan picks the next node instead of a heap: networks drawn by hand are
 * small enough that the constant factor of a heap costs more than it saves.
 */
export function findRoute(
  project: Project,
  network: Network,
  from: StationId,
  to: StationId,
  costs: RoutingCosts = DEFAULT_COSTS,
): Route | null {
  if (from === to) return null
  const stationExists = new Set(project.stations.map((s) => s.id))
  if (!stationExists.has(from) || !stationExists.has(to)) return null

  // Which lines serve a station, and which stations a line serves.
  const linesAt = (id: StationId): LineId[] =>
    (network.linesAtStation.get(id) ?? []).filter((lid) => {
      const l = project.lines.find((x) => x.id === lid)
      return l && !l.hidden
    })

  const stopsOfLine = new Map<LineId, Set<StationId>>()
  for (const l of project.lines) {
    if (!l.hidden) stopsOfLine.set(l.id, allStopsOfLine(l))
  }

  // Walking links, both directions.
  const walksFrom = new Map<StationId, StationId[]>()
  for (const t of project.transfers) {
    if (t.hidden) continue
    if (!stationExists.has(t.a) || !stationExists.has(t.b)) continue
    walksFrom.set(t.a, [...(walksFrom.get(t.a) ?? []), t.b])
    walksFrom.set(t.b, [...(walksFrom.get(t.b) ?? []), t.a])
  }

  /**
   * Neighbours of `station` reachable while staying on `line`.
   *
   * A branch marked `forward` may only be ridden in the order its stops are listed, so
   * only the following stop is offered. That is what makes a terminal loop or a one-way
   * running section behave: the return journey has to find another way round, exactly as
   * a passenger would.
   *
   * Stations the branch merely passes through are absent from `stops`, so they are
   * unreachable here by construction -- you cannot board an express where it does not
   * call, and nor can you alight.
   */
  const ridesFrom = (station: StationId, line: LineId): StationId[] => {
    const l = project.lines.find((x) => x.id === line)
    if (!l || l.hidden) return []
    const out: StationId[] = []
    for (const branch of l.branches) {
      const oneWay = branch.direction === 'forward'
      for (let i = 0; i < branch.stops.length; i++) {
        if (branch.stops[i] !== station) continue
        const before = branch.stops[i - 1]
        const after = branch.stops[i + 1]
        if (!oneWay && before && stationExists.has(before)) out.push(before)
        if (after && stationExists.has(after)) out.push(after)
      }
    }
    return out
  }

  const nodes = new Map<string, Node>()
  const done = new Set<string>()

  const push = (station: StationId, line: string, cost: number, prev: string | null) => {
    const k = key(station, line)
    if (done.has(k)) return
    const existing = nodes.get(k)
    if (existing && existing.cost <= cost) return
    nodes.set(k, { station, line, cost, prev })
  }

  // Boarding any line at the origin is free; so is starting on foot.
  for (const l of linesAt(from)) push(from, l, 0, null)
  push(from, WALK, 0, null)

  let goal: string | null = null

  while (true) {
    let bestKey: string | null = null
    let best = Infinity
    for (const [k, n] of nodes) {
      if (done.has(k)) continue
      if (n.cost < best) {
        best = n.cost
        bestKey = k
      }
    }
    if (!bestKey) break

    const node = nodes.get(bestKey)!
    done.add(bestKey)

    if (node.station === to) {
      goal = bestKey
      break
    }

    // Stay aboard.
    if (node.line !== WALK) {
      for (const next of ridesFrom(node.station, node.line as LineId)) {
        push(next, node.line, node.cost + costs.ride, bestKey)
      }
    }

    // Change to another line here.
    for (const other of linesAt(node.station)) {
      if (other === node.line) continue
      const penalty = node.line === WALK ? 0 : costs.interchange
      push(node.station, other, node.cost + penalty, bestKey)
    }

    // Walk an out-of-station link.
    for (const other of walksFrom.get(node.station) ?? []) {
      push(other, WALK, node.cost + costs.transfer, bestKey)
    }
  }

  if (!goal) return null

  // --- rebuild the journey ----------------------------------------------

  const chain: Node[] = []
  let cursor: string | null = goal
  while (cursor) {
    const n: Node | undefined = nodes.get(cursor)
    if (!n) break
    chain.unshift(n)
    cursor = n.prev
  }

  const legs: RouteLeg[] = []
  for (const n of chain) {
    const lineId = n.line === WALK ? null : (n.line as LineId)
    const last = legs[legs.length - 1]
    if (last && last.lineId === lineId) {
      if (last.stops[last.stops.length - 1] !== n.station) last.stops.push(n.station)
    } else {
      // A new leg starts where the previous one ended, so the join reads continuously.
      const start = last ? last.stops[last.stops.length - 1] : null
      const stops = start && start !== n.station ? [start, n.station] : [n.station]
      legs.push({ lineId, stops })
    }
  }

  // Drop legs that never actually moved — an artefact of changing line at a station.
  const real = legs.filter((l) => l.stops.length > 1)
  if (real.length === 0) return null

  const path: StationId[] = []
  for (const leg of real) {
    for (const s of leg.stops) {
      if (path[path.length - 1] !== s) path.push(s)
    }
  }

  const walks = real.filter((l) => l.lineId === null).length
  return {
    legs: real,
    path,
    stopCount: Math.max(0, path.length - 1),
    interchanges: Math.max(0, real.length - 1 - walks),
    walks,
  }
}

/** Which lines could carry you directly between two stations, if any. */
export function directLines(
  project: Project,
  from: StationId,
  to: StationId,
): LineId[] {
  const out: LineId[] = []
  for (const l of project.lines) {
    if (l.hidden) continue
    const stops = allStopsOfLine(l)
    if (stops.has(from) && stops.has(to)) out.push(l.id)
  }
  return out
}
