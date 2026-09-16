/**
 * The snapping engine.
 *
 * Two families of constraint, both treated as full lines rather than points:
 *
 *   ANGLES  radiate from a station's CONNECTED NEIGHBOURS at 0/45/90°. This is the
 *           constraint that makes a diagram read as octilinear.
 *   LEVELS  run parallel to an existing corridor, one per line in the bundle plus one
 *           just outside each edge. Snapping to a level puts your route exactly on the
 *           track of a specific line through a multi-line stop; snapping to the level
 *           outside the bundle runs it alongside — the "passes through without
 *           stopping" position.
 *
 * Before levels existed, a route drawn alongside a multi-line stop could only land on
 * the station's centre, which is the middle of the bundle and almost never what you
 * wanted.
 *
 * Strength order, strongest first:
 *   1. two constraint lines crossing   (fully determined, feels magnetic)
 *   2. a constraint crossing an alignment
 *   3. equal spacing along a constraint
 *   4. a single constraint, slid to the grid
 *   5. alignment on x and y independently
 *   6. bare grid
 *
 * Alt suspends the whole thing; each family toggles independently in `SnapSettings`.
 */

import { add, dist, dot, len, lineIntersect, mul, norm, sub } from './geometry'
import type { SnapKind, SnapSettings, StationId, Vec2 } from './types'

const DEG = Math.PI / 180

/** Four distinct lines suffice: as lines (not rays) they cover all eight directions. */
const ANGLE_DIRS: Vec2[] = [0, 45, 90, 135].map((d) => ({
  x: Math.cos(d * DEG),
  y: Math.sin(d * DEG),
}))

export interface GuideLine {
  kind: SnapKind
  from: Vec2
  to: Vec2
}

/** A parallel track through a corridor, produced by `stationLevelGuides`. */
export interface LevelGuide {
  origin: Vec2
  dir: Vec2
  /** 0 for a real line in the bundle, ±1 for the pass-by track just outside it. */
  outside: number
}

export interface SnapInput {
  /** Raw cursor position in the active space. */
  raw: Vec2
  /** Station being moved; excluded from every candidate source. */
  movingId?: StationId | null
  /** Positions of the stations this one connects to — the angle-ray origins. */
  neighbours: Vec2[]
  /** Every other station, for alignment snapping. */
  others: Vec2[]
  /**
   * Reference gaps for equal-spacing snapping: the distance from a neighbour to ITS
   * other neighbour, so a run of stations comes out evenly spaced without measuring.
   */
  spacing: { origin: Vec2; distance: number }[]
  /** Parallel tracks through nearby corridors. */
  levels: LevelGuide[]
  settings: SnapSettings
}

export interface SnapOutput {
  point: Vec2
  guides: GuideLine[]
  applied: SnapKind[]
  snapped: boolean
}

interface Line2 {
  origin: Vec2
  dir: Vec2
}

interface Constraint {
  line: Line2
  kind: SnapKind
}

const projectOnLine = (p: Vec2, l: Line2): Vec2 =>
  add(l.origin, mul(l.dir, dot(sub(p, l.origin), l.dir)))

const GUIDE_LEN = 4000

const guideFor = (kind: SnapKind, l: Line2): GuideLine => ({
  kind,
  from: sub(l.origin, mul(l.dir, GUIDE_LEN)),
  to: add(l.origin, mul(l.dir, GUIDE_LEN)),
})

const quantize = (p: Vec2): Vec2 => ({
  x: Math.round(p.x * 100) / 100,
  y: Math.round(p.y * 100) / 100,
})

export function snapPoint(input: SnapInput): SnapOutput {
  const { raw, neighbours, others, spacing, levels, settings } = input
  const tol = settings.tolerance
  const none: SnapOutput = { point: { ...raw }, guides: [], applied: [], snapped: false }

  if (!settings.angle && !settings.grid && !settings.align && !settings.spacing && !settings.levels) {
    return none
  }

  // --- candidate constraints -------------------------------------------

  const strong: Constraint[] = []
  if (settings.angle) {
    for (const n of neighbours) {
      for (const dir of ANGLE_DIRS) strong.push({ line: { origin: n, dir }, kind: 'angle' })
    }
  }
  if (settings.levels) {
    for (const l of levels) {
      strong.push({ line: { origin: l.origin, dir: l.dir }, kind: 'levels' })
    }
  }

  const alignLines: Constraint[] = []
  if (settings.align) {
    for (const o of others) {
      alignLines.push({ line: { origin: o, dir: { x: 1, y: 0 } }, kind: 'align' })
      alignLines.push({ line: { origin: o, dir: { x: 0, y: 1 } }, kind: 'align' })
    }
  }

  let best: { point: Vec2; d: number; guides: GuideLine[]; applied: SnapKind[] } | null = null

  const consider = (
    point: Vec2 | null,
    guides: GuideLine[],
    applied: SnapKind[],
    bias = 0,
  ) => {
    if (!point) return
    const d = dist(raw, point) + bias
    if (d > tol) return
    if (!best || d < best.d) best = { point, d, guides, applied }
  }

  const cross = (a: Line2, b: Line2): Vec2 | null =>
    lineIntersect(a.origin, add(a.origin, a.dir), b.origin, add(b.origin, b.dir))

  // --- 1. two constraints crossing --------------------------------------

  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      const a = strong[i]
      const b = strong[j]
      // Rays sharing an origin only ever meet at that origin, which is where the
      // station already is.
      if (dist(a.line.origin, b.line.origin) < 1e-6) continue
      consider(
        cross(a.line, b.line),
        [guideFor(a.kind, a.line), guideFor(b.kind, b.line)],
        a.kind === b.kind ? [a.kind] : [a.kind, b.kind],
      )
    }
  }
  if (best) return finish(best)

  // --- 2. a constraint crossing an alignment ----------------------------

  for (const a of strong) {
    for (const b of alignLines) {
      if (dist(a.line.origin, b.line.origin) < 1e-6) continue
      consider(
        cross(a.line, b.line),
        [guideFor(a.kind, a.line), guideFor('align', b.line)],
        [a.kind, 'align'],
      )
    }
  }
  if (best) return finish(best)

  // --- 3. equal spacing along a constraint ------------------------------

  if (settings.spacing) {
    for (const ref of spacing) {
      for (const a of strong) {
        if (dist(a.line.origin, ref.origin) > 1e-6) continue
        for (const sign of [1, -1]) {
          consider(
            add(a.line.origin, mul(a.line.dir, sign * ref.distance)),
            [guideFor(a.kind, a.line)],
            [a.kind, 'spacing'],
          )
        }
      }
      // Spacing with no other constraint: keep the direction, fix the distance.
      const d = sub(raw, ref.origin)
      if (len(d) > 1e-6) {
        consider(add(ref.origin, mul(norm(d), ref.distance)), [], ['spacing'], tol * 0.5)
      }
    }
  }
  if (best) return finish(best)

  // --- 4. a single constraint, slid to the grid -------------------------

  let nearest: { c: Constraint; p: Vec2; d: number } | null = null
  for (const a of strong) {
    const p = projectOnLine(raw, a.line)
    const d = dist(raw, p)
    if (d <= tol && (!nearest || d < nearest.d)) nearest = { c: a, p, d }
  }
  if (nearest) {
    const n = nearest as { c: Constraint; p: Vec2; d: number }
    let point = n.p
    const applied: SnapKind[] = [n.c.kind]
    if (settings.grid) {
      const g = settings.gridSize
      const t = dot(sub(n.p, n.c.line.origin), n.c.line.dir)
      const candidate = add(n.c.line.origin, mul(n.c.line.dir, Math.round(t / g) * g))
      if (dist(candidate, n.p) <= tol) {
        point = candidate
        applied.push('grid')
      }
    }
    return finish({ point, d: n.d, guides: [guideFor(n.c.kind, n.c.line)], applied })
  }

  // --- 5. alignment on each axis independently --------------------------

  const point = { ...raw }
  const guides: GuideLine[] = []
  const applied: SnapKind[] = []

  if (settings.align) {
    let bx: { val: number; d: number; o: Vec2 } | null = null
    let by: { val: number; d: number; o: Vec2 } | null = null
    for (const o of others) {
      const dx = Math.abs(o.x - raw.x)
      if (dx <= tol && (!bx || dx < bx.d)) bx = { val: o.x, d: dx, o }
      const dy = Math.abs(o.y - raw.y)
      if (dy <= tol && (!by || dy < by.d)) by = { val: o.y, d: dy, o }
    }
    if (bx) {
      point.x = bx.val
      guides.push(guideFor('align', { origin: bx.o, dir: { x: 0, y: 1 } }))
      applied.push('align')
    }
    if (by) {
      point.y = by.val
      guides.push(guideFor('align', { origin: by.o, dir: { x: 1, y: 0 } }))
      if (!applied.includes('align')) applied.push('align')
    }
  }

  // --- 6. bare grid on whatever is still free ---------------------------

  if (settings.grid) {
    const g = settings.gridSize
    if (!applied.includes('align') || point.x === raw.x) {
      const gx = Math.round(raw.x / g) * g
      if (Math.abs(gx - raw.x) <= tol) {
        point.x = gx
        if (!applied.includes('grid')) applied.push('grid')
      }
    }
    if (!applied.includes('align') || point.y === raw.y) {
      const gy = Math.round(raw.y / g) * g
      if (Math.abs(gy - raw.y) <= tol) {
        point.y = gy
        if (!applied.includes('grid')) applied.push('grid')
      }
    }
  }

  if (applied.length === 0) return none
  return { point: quantize(point), guides, applied, snapped: true }
}

function finish(b: {
  point: Vec2
  d: number
  guides: GuideLine[]
  applied: SnapKind[]
}): SnapOutput {
  // Intersections land on irrational coordinates. Rounding here keeps float noise from
  // accumulating across drags and keeps exported path data readable.
  return { point: quantize(b.point), guides: b.guides, applied: b.applied, snapped: true }
}

/**
 * Build the spacing references for a station: for each neighbour, how far that
 * neighbour sits from its OTHER neighbour. Matching that distance is what produces an
 * evenly spaced run without anyone measuring anything.
 */
export function spacingRefsFor(
  movingPos: Vec2,
  neighbourPositions: { pos: Vec2; theirNeighbours: Vec2[] }[],
): { origin: Vec2; distance: number }[] {
  const out: { origin: Vec2; distance: number }[] = []
  for (const n of neighbourPositions) {
    for (const t of n.theirNeighbours) {
      if (dist(t, movingPos) < 1e-6) continue
      const d = dist(n.pos, t)
      if (d > 1e-6) out.push({ origin: n.pos, distance: d })
    }
  }
  return out
}
