/**
 * Tidying a diagram towards the shape Beck drew.
 *
 * A schematic map obeys rules a geographic one does not: every line runs at a multiple
 * of 45°, stops are spaced evenly rather than truly, lines bend as little as possible,
 * and nothing that is north of something else ends up south of it. Doing that by hand is
 * most of the work of making one of these maps, and it is the part a machine is good at.
 *
 * The method is hill climbing, after Stott and Rodgers' work on metro map layout: score
 * the drawing, try moving one station at a time to a handful of nearby positions, keep
 * what improves the score, and shrink the step as it settles. It is not a solver and
 * makes no claim to an optimum — a mixed-integer formulation would, and would also take
 * minutes and a dependency. This runs in a fraction of a second on a full map and gives
 * back something a person would have spent an afternoon nudging.
 *
 * Two properties matter more than the score:
 *
 *   it is DETERMINISTIC — the same map tidies the same way every time, because a layout
 *   that shuffles on every run cannot be reviewed, committed, or trusted; and
 *
 *   it is HONEST about topology — relative position is a hard cost, so tidying never
 *   turns a line inside out to save a few degrees.
 */

import { dist } from './geometry'
import { branchSequence, stationMap, type Network, type Space } from './network'
import type { Project, StationId, Vec2 } from './types'

export interface TidyOptions {
  space?: Space
  /** Only these stations move. Empty or absent means the whole map. */
  ids?: StationId[]
  /** Target distance between neighbouring stops. Defaults to the map's own median. */
  step?: number
  /** More rounds, finer result, longer wait. Six is plenty for a map of any size. */
  rounds?: number
}

export interface TidyResult {
  positions: Map<StationId, Vec2>
  /** Score before and after, for reporting. Lower is tidier. */
  before: number
  after: number
  moved: number
}

const EIGHTH = Math.PI / 4

/** How far this direction is from the nearest 45°, in eighths of a turn. */
function offAxis(from: Vec2, to: Vec2): number {
  const a = Math.atan2(to.y - from.y, to.x - from.x)
  const k = Math.round(a / EIGHTH)
  return Math.abs(a - k * EIGHTH) / (EIGHTH / 2)
}

interface Graph {
  /** Undirected neighbours. */
  near: Map<StationId, StationId[]>
  /** Consecutive triples along a line, for the straightness term. */
  triples: [StationId, StationId, StationId][]
  /** Every edge once, for the occlusion term. */
  edges: [StationId, StationId][]
}

function graphOf(project: Project, network: Network, space: Space): Graph {
  const near = new Map<StationId, StationId[]>()
  for (const [id, set] of network.neighbours) near.set(id, [...set].sort())

  const stations = stationMap(project)
  const triples: [StationId, StationId, StationId][] = []
  for (const line of project.lines) {
    if (line.hidden) continue
    for (const branch of line.branches) {
      const { ids } = branchSequence(branch, stations, space)
      for (let i = 1; i < ids.length - 1; i++) {
        if (ids[i - 1] === ids[i] || ids[i] === ids[i + 1]) continue
        triples.push([ids[i - 1], ids[i], ids[i + 1]])
      }
    }
  }

  const seen = new Set<string>()
  const edges: [StationId, StationId][] = []
  for (const [id, list] of near) {
    for (const other of list) {
      const key = id < other ? `${id}|${other}` : `${other}|${id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([id, other])
    }
  }
  return { near, triples, edges }
}

/** Weights. Relative position is dear because getting it wrong is a different map. */
const W_OCTILINEAR = 1
const W_LENGTH = 0.55
const W_STRAIGHT = 0.8
const W_FLIP = 14
const W_CLEAR = 3

/** Below this many multiples of `step`, a station is too close to an edge it is not on. */
const CLEAR = 0.42

/**
 * What one station contributes to the score at a given position.
 *
 * Local by construction: only the terms that mention this station change when it moves,
 * so a candidate can be judged without re-scoring the map.
 */
function costAt(
  id: StationId,
  p: Vec2,
  at: Map<StationId, Vec2>,
  origin: Map<StationId, Vec2>,
  g: Graph,
  step: number,
): number {
  let cost = 0
  const pos = (x: StationId) => (x === id ? p : (at.get(x) ?? p))

  for (const n of g.near.get(id) ?? []) {
    const q = pos(n)
    cost += W_OCTILINEAR * offAxis(p, q) ** 2

    const d = dist(p, q)
    cost += W_LENGTH * ((d - step) / step) ** 2

    // Relative position: whichever side of this station its neighbour started on, it
    // stays on. This is the term that stops tidying from rewriting the network.
    const o1 = origin.get(id)
    const o2 = origin.get(n)
    if (o1 && o2) {
      const wantX = Math.sign(o2.x - o1.x)
      const wantY = Math.sign(o2.y - o1.y)
      const gotX = Math.sign(q.x - p.x)
      const gotY = Math.sign(q.y - p.y)
      if (wantX !== 0 && gotX !== 0 && wantX !== gotX) cost += W_FLIP
      if (wantY !== 0 && gotY !== 0 && wantY !== gotY) cost += W_FLIP
    }
  }

  // Lines want to carry straight on through a stop.
  for (const [a, b, c] of g.triples) {
    if (a !== id && b !== id && c !== id) continue
    const pa = pos(a)
    const pb = pos(b)
    const pc = pos(c)
    const in1 = Math.atan2(pb.y - pa.y, pb.x - pa.x)
    const in2 = Math.atan2(pc.y - pb.y, pc.x - pb.x)
    let turn = Math.abs(in2 - in1)
    if (turn > Math.PI) turn = 2 * Math.PI - turn
    cost += W_STRAIGHT * (turn / Math.PI) ** 2
  }

  // And nothing should come to rest on top of a line it has nothing to do with.
  const mine = new Set(g.near.get(id) ?? [])
  const reach = step * 1.6
  for (const [a, b] of g.edges) {
    if (a === id || b === id) continue
    if (mine.has(a) && mine.has(b)) continue
    const pa = pos(a)
    const pb = pos(b)
    if (Math.abs(pa.x - p.x) > reach && Math.abs(pb.x - p.x) > reach) continue
    if (Math.abs(pa.y - p.y) > reach && Math.abs(pb.y - p.y) > reach) continue
    const vx = pb.x - pa.x
    const vy = pb.y - pa.y
    const len2 = vx * vx + vy * vy
    if (len2 < 1e-9) continue
    let t = ((p.x - pa.x) * vx + (p.y - pa.y) * vy) / len2
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(p.x - (pa.x + vx * t), p.y - (pa.y + vy * t))
    const want = step * CLEAR
    if (d < want) cost += W_CLEAR * ((want - d) / want) ** 2
  }

  return cost
}

/** The median distance between neighbouring stops — what "evenly spaced" should mean. */
export function medianSpacing(project: Project, network: Network, space: Space): number {
  const at = stationMap(project)
  const lengths: number[] = []
  const seen = new Set<string>()
  for (const [id, set] of network.neighbours) {
    for (const other of set) {
      const key = id < other ? `${id}|${other}` : `${other}|${id}`
      if (seen.has(key)) continue
      seen.add(key)
      const a = at.get(id)
      const b = at.get(other)
      if (a && b) lengths.push(dist(a[space], b[space]))
    }
  }
  if (lengths.length === 0) return 120
  lengths.sort((a, b) => a - b)
  return Math.max(24, lengths[Math.floor(lengths.length / 2)])
}

export function tidyLayout(
  project: Project,
  network: Network,
  opts: TidyOptions = {},
): TidyResult {
  const space = opts.space ?? 'schematic'
  const g = graphOf(project, network, space)
  const step = opts.step ?? medianSpacing(project, network, space)
  const rounds = opts.rounds ?? 6

  const at = new Map<StationId, Vec2>()
  for (const s of project.stations) at.set(s.id, { ...s[space] })
  const origin = new Map<StationId, Vec2>(
    project.stations.map((s) => [s.id, { ...s[space] }]),
  )

  // Fixed order, fixed candidate set, no randomness anywhere: a layout that shuffles on
  // every run cannot be reviewed or committed.
  const movable = (opts.ids && opts.ids.length > 0 ? opts.ids : project.stations.map((s) => s.id))
    .filter((id) => g.near.has(id))
    .slice()
    .sort()

  const score = () => {
    let total = 0
    for (const id of movable) total += costAt(id, at.get(id)!, at, origin, g, step)
    return total
  }
  const before = score()

  const dirs: Vec2[] = []
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8
    dirs.push({ x: Math.cos(a), y: Math.sin(a) })
  }

  for (let round = 0; round < rounds; round++) {
    const radius = step * Math.pow(0.55, round)
    for (const id of movable) {
      const here = at.get(id)!
      let best = here
      let bestCost = costAt(id, here, at, origin, g, step)
      for (const d of dirs) {
        const candidate = { x: here.x + d.x * radius, y: here.y + d.y * radius }
        const c = costAt(id, candidate, at, origin, g, step)
        if (c < bestCost - 1e-9) {
          bestCost = c
          best = candidate
        }
      }
      if (best !== here) at.set(id, best)
    }
  }

  // A last pass onto a tidy lattice, so the result has round numbers in it rather than
  // the residue of sixteen directions and six radii.
  const grid = step / 4
  for (const id of movable) {
    const p = at.get(id)!
    const snapped = { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid }
    if (costAt(id, snapped, at, origin, g, step) <= costAt(id, p, at, origin, g, step) + 0.25) {
      at.set(id, snapped)
    }
  }

  let moved = 0
  const positions = new Map<StationId, Vec2>()
  for (const id of movable) {
    const p = at.get(id)!
    const o = origin.get(id)!
    if (dist(p, o) > 0.5) moved++
    positions.set(id, { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })
  }

  return { positions, before, after: score(), moved }
}
