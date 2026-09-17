/**
 * Where one line passes over another.
 *
 * A casing drawn along a line's whole length is wrong twice over: in a shared corridor
 * it reaches into the neighbouring track and eats it, and anywhere else it paints the
 * background over whatever it is passing — a river, a park, the lot. Real maps do not
 * do that. The break only ever appears at the point of a crossing.
 *
 * So the actual crossing points are found and the upper line gets a short bridge at each
 * one. Everywhere else, nothing is painted out.
 */

import { add, dist, mul, norm, sub } from './geometry'
import type { CrossingOverride, Vec2 } from './types'

export interface RenderedSegment {
  a: Vec2
  b: Vec2
  /** Canonical key of the stop pair this belongs to; several sub-segments may share it. */
  segKey: string
}

export interface RenderedLine {
  id: string
  /** Position in draw order; higher passes over lower unless a crossing says otherwise. */
  z: number
  /** Stroke width as drawn. */
  width: number
  segments: RenderedSegment[]
}

export interface Crossing {
  /** Stable identity, so an override outlives a redraw. See `crossingKey`. */
  key: string
  /** The line that passes over, and therefore carries the bridge. */
  upper: string
  /** The line broken by it. */
  lower: string
  at: Vec2
  /** Direction of the upper line where it crosses. */
  dir: Vec2
  /** Total bridge length along the upper line. */
  length: number
  /** Total bridge thickness across the upper line. */
  height: number
  /** True when this crossing has been tuned by hand. */
  overridden: boolean
}

/**
 * Identify a crossing by the two stop-pairs that produce it, ordered canonically so it
 * does not matter which line is considered first.
 *
 * Deliberately NOT positional: stations move constantly while composing a diagram, and
 * a key based on coordinates would lose its override on the first drag. Keying on
 * topology also means that rewiring a line correctly abandons the old override rather
 * than applying it to an unrelated crossing.
 */
export function crossingKey(
  lineA: string,
  segA: string,
  lineB: string,
  segB: string,
  occurrence: number,
): string {
  const x = `${lineA}~${segA}`
  const y = `${lineB}~${segB}`
  const [lo, hi] = x < y ? [x, y] : [y, x]
  return `${lo}|${hi}#${occurrence}`
}

/**
 * True crossing point of two segments, or null. Endpoints are excluded: lines meeting
 * at a shared station touch at their endpoints, and that is a junction, not a crossing.
 */
function segmentCross(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const d1 = sub(p2, p1)
  const d2 = sub(p4, p3)
  const denom = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(denom) < 1e-9) return null // parallel — the shared-corridor case

  const dx = p3.x - p1.x
  const dy = p3.y - p1.y
  const t = (dx * d2.y - dy * d2.x) / denom
  const u = (dx * d1.y - dy * d1.x) / denom

  const E = 1e-4
  if (t <= E || t >= 1 - E || u <= E || u >= 1 - E) return null
  return add(p1, mul(d1, t))
}

/** Bounding boxes overlap? A cheap reject before the real arithmetic. */
function boxesMiss(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2, pad: number): boolean {
  return (
    Math.max(a1.x, a2.x) + pad < Math.min(b1.x, b2.x) ||
    Math.min(a1.x, a2.x) - pad > Math.max(b1.x, b2.x) ||
    Math.max(a1.y, a2.y) + pad < Math.min(b1.y, b2.y) ||
    Math.min(a1.y, a2.y) - pad > Math.max(b1.y, b2.y)
  )
}

export interface CrossingOptions {
  /** Default clearance along the upper line, past the line underneath. */
  length: number
  /** Default clearance across the upper line, past its own edges. */
  height: number
  overrides?: Record<string, CrossingOverride>
}

/** A station, and which lines actually call there. */
export interface Junction {
  at: Vec2
  calling: Set<string>
}

/**
 * Every point where one line crosses another.
 *
 * `avoid` are the stations. A crossing that lands on one is usually a junction, and
 * breaking a line there would carve a notch out of an interchange — but only if both
 * lines actually stop. A line merely crossing a station it does not serve has to keep
 * its break, or it runs straight through the symbol and reads as calling there. That is
 * the single most misleading thing a transit map can do: state the opposite of the
 * timetable.
 */
export function findCrossings(
  lines: RenderedLine[],
  avoid: Junction[],
  avoidRadius: number,
  opts: CrossingOptions,
): Crossing[] {
  const out: Crossing[] = []
  if (lines.length < 2) return out

  const overrides = opts.overrides ?? {}
  const anyDefault = opts.length > 0 || opts.height > 0
  // With both defaults at zero there is nothing to draw unless a crossing asks for it.
  if (!anyDefault && Object.keys(overrides).length === 0) return out

  interface Seg extends RenderedSegment {
    line: number
  }
  const segs: Seg[] = []
  lines.forEach((l, li) => {
    for (const s of l.segments) {
      if (dist(s.a, s.b) < 1e-6) continue
      segs.push({ ...s, line: li })
    }
  })

  const pad = Math.max(...lines.map((l) => l.width), 0) + Math.max(opts.length, opts.height) * 2
  const seen = new Map<string, number>()

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s1 = segs[i]
      const s2 = segs[j]
      if (s1.line === s2.line) continue // a line crossing itself needs no break
      if (boxesMiss(s1.a, s1.b, s2.a, s2.b, pad)) continue

      const at = segmentCross(s1.a, s1.b, s2.a, s2.b)
      if (!at) continue

      const idA = lines[s1.line].id
      const idB = lines[s2.line].id
      // Suppressed only at a true junction: a station where BOTH lines stop.
      const junction = avoid.some(
        (j) => dist(j.at, at) < avoidRadius && j.calling.has(idA) && j.calling.has(idB),
      )
      if (junction) continue
      // Two bent stop-pairs can meet more than once; number them so each gets its own
      // identity rather than sharing one override.
      const pairId = crossingKey(idA, s1.segKey, idB, s2.segKey, 0)
      const base = pairId.slice(0, pairId.lastIndexOf('#'))
      const occurrence = seen.get(base) ?? 0
      seen.set(base, occurrence + 1)
      const key = `${base}#${occurrence}`

      const o = overrides[key] ?? {}
      if (o.off) continue

      const byOrder = lines[s1.line].z > lines[s2.line].z ? s1 : s2
      const upperSeg = o.flip ? (byOrder === s1 ? s2 : s1) : byOrder
      const lowerSeg = upperSeg === s1 ? s2 : s1

      const length = o.length ?? opts.length
      const height = o.height ?? opts.height
      if (length <= 0 && height <= 0) continue

      const dir = norm(sub(upperSeg.b, upperSeg.a))
      const other = norm(sub(lowerSeg.b, lowerSeg.a))

      // Seen along the upper line, a shallow crossing hides far more of the lower line
      // than a square one. Clamped, because at a very shallow angle the exact figure
      // runs away and a huge bridge would look worse than a slightly short one.
      const sin = Math.abs(dir.x * other.y - dir.y * other.x)
      const spread = lines[lowerSeg.line].width / Math.max(0.34, sin)

      out.push({
        key,
        upper: lines[upperSeg.line].id,
        lower: lines[lowerSeg.line].id,
        at,
        dir,
        length: spread + length * 2,
        height: lines[upperSeg.line].width + height * 2,
        overridden: key in overrides,
      })
    }
  }

  return out
}
