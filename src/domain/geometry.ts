import type { Vec2 } from './types'

// ---------------------------------------------------------------------------
// Vector basics
// ---------------------------------------------------------------------------

export const v = (x: number, y: number): Vec2 => ({ x, y })
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const len = (a: Vec2): number => Math.hypot(a.x, a.y)
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y)
export const eq = (a: Vec2, b: Vec2, e = 1e-6): boolean =>
  Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e

export function norm(a: Vec2): Vec2 {
  const l = len(a)
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

/** Left-hand normal of a direction vector (screen coords: y grows downward). */
export const perp = (a: Vec2): Vec2 => ({ x: a.y, y: -a.x })

export const round = (a: Vec2, dp = 2): Vec2 => {
  const f = 10 ** dp
  return { x: Math.round(a.x * f) / f, y: Math.round(a.y * f) / f }
}

// ---------------------------------------------------------------------------
// Octilinear helpers — the 0/45/90 constraint that makes a diagram read as transit
// ---------------------------------------------------------------------------

const EIGHTH = Math.PI / 4

/** The eight compass directions, as unit vectors. */
export const DIRS_8: Vec2[] = Array.from({ length: 8 }, (_, i) => ({
  x: Math.cos(i * EIGHTH),
  y: Math.sin(i * EIGHTH),
}))

/** Nearest of the eight octilinear directions to `d`. */
export function snapDir45(d: Vec2): Vec2 {
  if (len(d) < 1e-9) return { x: 1, y: 0 }
  const k = Math.round(Math.atan2(d.y, d.x) / EIGHTH)
  return { x: Math.cos(k * EIGHTH), y: Math.sin(k * EIGHTH) }
}

/**
 * Project `to` onto the nearest octilinear ray from `from`. The result keeps as much
 * of the original extent as possible (perpendicular foot), which is what makes a
 * snapped drag feel like it followed the cursor rather than jumping.
 */
export function snapPointTo45(from: Vec2, to: Vec2): Vec2 {
  const d = sub(to, from)
  const dir = snapDir45(d)
  const t = Math.max(0, dot(d, dir))
  return add(from, mul(dir, t))
}

/** Rewrite a run of points so every segment is octilinear, walking from the first. */
export function octilinearizeRun(pts: Vec2[]): Vec2[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }))
  const out: Vec2[] = [{ ...pts[0] }]
  for (let i = 1; i < pts.length; i++) {
    out.push(snapPointTo45(out[i - 1], pts[i]))
  }
  return out
}

// ---------------------------------------------------------------------------
// Lines and intersections
// ---------------------------------------------------------------------------

/** Intersection of two INFINITE lines through (a1,a2) and (b1,b2). Null if parallel. */
export function lineIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const dax = a2.x - a1.x
  const day = a2.y - a1.y
  const dbx = b2.x - b1.x
  const dby = b2.y - b1.y
  const denom = dax * dby - day * dbx
  if (Math.abs(denom) < 1e-9) return null
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom
  return { x: a1.x + dax * t, y: a1.y + day * t }
}

/** Closest point to `p` on the SEGMENT a-b. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  if (l2 < 1e-9) return { ...a }
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))
  return add(a, mul(ab, t))
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestOnSegment(p, a, b))
}

/** Distance from `p` to the nearest point on a polyline, plus which segment won. */
export function closestOnPolyline(
  p: Vec2,
  pts: Vec2[],
): { point: Vec2; distance: number; index: number } | null {
  if (pts.length < 2) return null
  let best = { point: pts[0], distance: Infinity, index: 0 }
  for (let i = 0; i < pts.length - 1; i++) {
    const c = closestOnSegment(p, pts[i], pts[i + 1])
    const d = dist(p, c)
    if (d < best.distance) best = { point: c, distance: d, index: i }
  }
  return best
}

// ---------------------------------------------------------------------------
// Parallel offsetting — how shared corridors are drawn
// ---------------------------------------------------------------------------

/**
 * Offset a polyline laterally, allowing a DIFFERENT offset per segment so a line can
 * join and leave corridors mid-route. `offsets.length` must be `pts.length - 1`.
 *
 * Each segment is shifted along its own left normal, then consecutive shifted segments
 * are extended to their intersection. That intersection is what makes the joins meet
 * cleanly instead of showing a notch at every corner.
 */
export function offsetPolyline(pts: Vec2[], offsets: number[]): Vec2[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }))

  type Seg = { a: Vec2; b: Vec2 }
  const segs: Seg[] = []
  let lastDir: Vec2 = { x: 1, y: 0 }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const d = sub(b, a)
    // A coincident pair still emits a segment: dropping it here would shift every
    // later index and break the stop-index mapping callers depend on.
    const dir = len(d) < 1e-9 ? lastDir : norm(d)
    lastDir = dir
    const n = mul(perp(dir), offsets[i] ?? 0)
    segs.push({ a: add(a, n), b: add(b, n) })
  }
  if (segs.length === 0) return pts.map((p) => ({ ...p }))

  const out: Vec2[] = [segs[0].a]
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1]
    const cur = segs[i]
    const hit = lineIntersect(prev.a, prev.b, cur.a, cur.b)
    // Parallel (straight-through) or a near-reversal: fall back to the shifted vertex.
    // Exactly one point is emitted per input vertex either way, because callers map
    // stop indices straight through this function to find a click's segment.
    if (hit && dist(hit, prev.b) < 1e4) out.push(hit)
    else out.push(prev.b)
  }
  out.push(segs[segs.length - 1].b)
  return out
}

// ---------------------------------------------------------------------------
// Path construction
// ---------------------------------------------------------------------------

const fmt = (p: Vec2) => `${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`

/**
 * SVG path for a polyline, with corners rounded by `radius`. Rounding uses a quadratic
 * through trimmed points with the corner as control — visually identical to a circular
 * arc at transit-map radii, and far less arithmetic.
 */
/**
 * Path through a run of points, with corners rounded.
 *
 * `radius` is the ordinary octilinear joint rounding, applied everywhere. `curved`
 * marks individual vertices that should instead be rounded as hard as their
 * neighbouring segments allow -- the sweeping arc Madrid and Berlin draw, where the
 * corner IS the shape rather than a joint between two straights. A fixed small radius
 * cannot express that, and raising `cornerRadius` globally would soften every joint on
 * the map to get one curve.
 */
export function polylinePath(pts: Vec2[], radius = 0, curved?: boolean[]): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M ${fmt(pts[0])}`
  const anyCurved = curved?.some(Boolean) ?? false
  if ((radius <= 0.01 && !anyCurved) || pts.length === 2) {
    return `M ${pts.map(fmt).join(' L ')}`
  }

  let d = `M ${fmt(pts[0])}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    // A curved vertex takes the largest arc its two segments can carry; half of the
    // shorter one is the limit before the curve would overrun the neighbouring corner.
    const r = curved?.[i] ? Math.min(dist(prev, cur), dist(cur, next)) / 2 : radius
    const rIn = Math.min(r, dist(prev, cur) / 2)
    const rOut = Math.min(r, dist(cur, next) / 2)
    if (rIn < 0.01 || rOut < 0.01) {
      d += ` L ${fmt(cur)}`
      continue
    }
    const p1 = add(cur, mul(norm(sub(prev, cur)), rIn))
    const p2 = add(cur, mul(norm(sub(next, cur)), rOut))
    d += ` L ${fmt(p1)} Q ${fmt(cur)} ${fmt(p2)}`
  }
  d += ` L ${fmt(pts[pts.length - 1])}`
  return d
}

export function polygonPath(pts: Vec2[]): string {
  if (pts.length < 3) return ''
  return `M ${pts.map(fmt).join(' L ')} Z`
}

/**
 * A filled shape with rings cut out of it: an island in a lake, a courtyard in a park.
 *
 * Emitted as one path of several closed subpaths. Rendered with `fill-rule: evenodd`,
 * an inner ring punches a hole regardless of which way round it was traced -- which
 * matters because nobody tracing a lake thinks about winding order.
 */
export function polygonPathWithHoles(outer: Vec2[], holes: Vec2[][]): string {
  const head = polygonPath(outer)
  if (!head) return ''
  const rings = holes.map(polygonPath).filter(Boolean)
  return rings.length ? `${head} ${rings.join(' ')}` : head
}

// ---------------------------------------------------------------------------
// Simplification — turning a traced river into two straight strokes
// ---------------------------------------------------------------------------

/** Ramer-Douglas-Peucker. Higher `epsilon` means a blunter shape. */
export function simplify(pts: Vec2[], epsilon: number): Vec2[] {
  if (pts.length < 3 || epsilon <= 0) return pts.map((p) => ({ ...p }))

  let maxDist = 0
  let index = 0
  const first = pts[0]
  const last = pts[pts.length - 1]

  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], first, last)
    if (d > maxDist) {
      maxDist = d
      index = i
    }
  }

  if (maxDist <= epsilon) return [{ ...first }, { ...last }]

  const left = simplify(pts.slice(0, index + 1), epsilon)
  const right = simplify(pts.slice(index), epsilon)
  return [...left.slice(0, -1), ...right]
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const emptyBounds = (): Bounds => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
})

export function growBounds(b: Bounds, p: Vec2): Bounds {
  b.minX = Math.min(b.minX, p.x)
  b.minY = Math.min(b.minY, p.y)
  b.maxX = Math.max(b.maxX, p.x)
  b.maxY = Math.max(b.maxY, p.y)
  return b
}

export function padBounds(b: Bounds, pad: number): Bounds {
  return {
    minX: b.minX - pad,
    minY: b.minY - pad,
    maxX: b.maxX + pad,
    maxY: b.maxY + pad,
  }
}

export const boundsValid = (b: Bounds): boolean =>
  Number.isFinite(b.minX) && Number.isFinite(b.minY) && b.maxX >= b.minX && b.maxY >= b.minY

export const boundsSize = (b: Bounds) => ({
  width: Math.max(0, b.maxX - b.minX),
  height: Math.max(0, b.maxY - b.minY),
})


// ---------------------------------------------------------------------------
// Rectangle vs segment
// ---------------------------------------------------------------------------

export interface RectLike {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Exact test for whether a line segment touches a rectangle. Used by both the label
 * placer and the route-badge placer to keep text and bullets off the track.
 */
export function rectHitsSegment(r: RectLike, p1: Vec2, p2: Vec2, pad = 2): boolean {
  const x1 = r.x - pad
  const y1 = r.y - pad
  const x2 = r.x + r.w + pad
  const y2 = r.y + r.h + pad

  const inside = (p: Vec2) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2
  if (inside(p1) || inside(p2)) return true

  if (Math.max(p1.x, p2.x) < x1 || Math.min(p1.x, p2.x) > x2) return false
  if (Math.max(p1.y, p2.y) < y1 || Math.min(p1.y, p2.y) > y2) return false

  const side = (p: Vec2, q: Vec2, r2: Vec2) =>
    Math.sign((q.x - p.x) * (r2.y - p.y) - (q.y - p.y) * (r2.x - p.x))
  const crosses = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) =>
    side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)

  const corners: Vec2[] = [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ]
  for (let i = 0; i < 4; i++) {
    if (crosses(p1, p2, corners[i], corners[(i + 1) % 4])) return true
  }
  return false
}
