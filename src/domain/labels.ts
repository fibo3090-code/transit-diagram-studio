/**
 * Automatic label placement.
 *
 * Every station gets eight candidate positions around it. Each candidate is scored
 * against what is already on the map — other labels, nearby track, other stations —
 * and the cheapest one wins. Stations are placed in order of importance so that
 * interchanges claim the good spots before minor stops do.
 *
 * A label you have dragged is `pinned` and never touched by any of this.
 */

import { modeById } from './defaults'
import { placementDrawnExtent } from './furniture'
import { dist, offsetPolyline, rectHitsSegment } from './geometry'
import { branchGeometry, stationMap, type Network, type Space } from './network'
import { lineBadges } from './symbols'
import type { LabelAnchor, Project, Station, StationId, Vec2 } from './types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const CANDIDATES: LabelAnchor[] = ['e', 'w', 'ne', 'se', 'nw', 'sw', 'n', 's']

/** Cost added for each thing a candidate overlaps. Track matters most — it hides the map. */
const COST_LABEL_OVERLAP = 100
const COST_TRACK_OVERLAP = 60
const COST_STATION_OVERLAP = 45
const COST_ORDER = 4
/** Pushing a label out to the far ring. Dear enough to be a last resort. */
const COST_LIFT = 46

const DIR: Record<LabelAnchor, Vec2> = {
  auto: { x: 1, y: 0 },
  n: { x: 0, y: -1 },
  ne: { x: 0.72, y: -0.72 },
  e: { x: 1, y: 0 },
  se: { x: 0.72, y: 0.72 },
  s: { x: 0, y: 1 },
  sw: { x: -0.72, y: 0.72 },
  w: { x: -1, y: 0 },
  nw: { x: -0.72, y: -0.72 },
}

/**
 * Estimated text width. Measuring properly would need a canvas per frame; 0.55em per
 * character is close enough for collision purposes and costs nothing.
 */
export const estimateTextWidth = (text: string, fontSize: number): number =>
  text.length * fontSize * 0.55

/** Badge geometry, in ems. The renderer draws to these numbers; nothing else may. */
export const BADGE_DIAMETER = 0.78
const BADGE_STEP = 0.92
const BADGE_LEAD = 0.34

/**
 * Where a label's facility badges sit, measured from the end of the name and running in
 * the direction the text reads.
 *
 * Shared with the renderer on purpose. Badges used to be laid out from the label's
 * anchor point, which is where the name starts — so every station with a badge had its
 * first letters printed under a stack of little icons. The auto-placer knew nothing of
 * them either, so no room was reserved and moving the label could not help. One
 * function now answers both questions, and they cannot drift apart.
 */
export function badgeCenters(count: number, fontSize: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    out.push(fontSize * (BADGE_LEAD + BADGE_DIAMETER / 2 + i * BADGE_STEP))
  }
  return out
}

/**
 * The fare-zone chip that follows a label.
 *
 * It used to be drawn as a bare number floating above the name, which reads as a stray
 * digit rather than as information about that station — on a busy map it looks like
 * rendering debris, and it collided with whatever label sat above. On the line, in a box,
 * after the name, it is unmistakably part of the label.
 */
export const ZONE_LEAD = 0.34

export function zoneChipWidth(zone: string | undefined, fontSize: number): number {
  if (!zone) return 0
  const text = fontSize * 0.72 * 0.58 * zone.length
  return fontSize * ZONE_LEAD + Math.max(fontSize * 0.62, text) + fontSize * 0.34
}

/** How much width the badge strip adds beyond the end of the name. */
export function badgeStripWidth(count: number, fontSize: number): number {
  if (count <= 0) return 0
  return fontSize * (BADGE_LEAD + BADGE_DIAMETER + (count - 1) * BADGE_STEP)
}

/**
 * The box a label occupies — the box the renderer actually draws into.
 *
 * This has to mirror `LabelsLayer` exactly, because the auto-placer scores candidates by
 * this box and then the renderer ignores it and draws wherever it likes. When the two
 * disagreed, diagonal candidates were modelled as straddling the stop (the box was
 * centred on a point `gap + w/2` away along the diagonal, so a third of it lay back over
 * the station) while the text was actually drawn clear of it. Every diagonal therefore
 * scored a phantom collision with the crossing line, diagonals lost, and label after
 * label was placed due east — lying along the very track it names.
 *
 * So: anchor point first, exactly as the renderer computes it, then the box hung off it
 * the way the text hangs off its anchor.
 *
 * `extra.width` is anything drawn after the name on the same line — the badge strip;
 * `extra.height` anything drawn under it, such as a second name in another language.
 */
export function labelRect(
  pos: Vec2,
  anchor: LabelAnchor,
  text: string,
  fontSize: number,
  gap: number,
  offset: Vec2 = { x: 0, y: 0 },
  extra: { width?: number; height?: number } = {},
): Rect {
  const d = DIR[anchor] ?? DIR.e
  const extraWidth = extra.width ?? 0
  const extraHeight = extra.height ?? 0
  const textWidth = estimateTextWidth(text, fontSize)
  const w = textWidth + extraWidth

  const x = pos.x + d.x * gap + offset.x
  const y = pos.y + d.y * gap + offset.y

  // text-anchor: start / end / middle, on the renderer's own thresholds.
  const left =
    d.x > 0.3 ? x : d.x < -0.3 ? x - w : x - textWidth / 2
  // Baseline offset, then up by the ascender to reach the top of the line.
  const dy = d.y > 0.3 ? fontSize * 0.85 : d.y < -0.3 ? fontSize * -0.2 : fontSize * 0.32
  const top = y + dy - fontSize * 0.85

  return { x: left, y: top, w, h: fontSize * 1.15 + extraHeight }
}

/** Everything a label draws around its name, as the box-growing numbers above want it. */
export function labelExtras(project: Project, station: Station): { width: number; height: number } {
  const fs = project.style.fontSize
  const badges = project.view.showBadges ? badgeStripWidth(station.badges.length, fs) : 0
  const zone = project.view.showZones ? zoneChipWidth(station.zone, fs) : 0
  return {
    width: badges + zone,
    height: station.nameSecondary ? fs * project.style.secondaryNameScale * 1.15 : 0,
  }
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/**
 * Where one label ended up.
 *
 * `lift` is how far beyond the usual gap it had to be pushed to find clear space. It is
 * almost always zero; when it is not, the renderer draws a hairline from the stop to the
 * name, because a label that has been moved out of its own crowd stops obviously
 * belonging to anything. That leader is what every printed map does in a dense core, and
 * it is the difference between "this name is further away" and "this name is adrift".
 */
export interface Placed {
  anchor: LabelAnchor
  lift: number
}

export interface PlacedLabel {
  id: StationId
  anchor: LabelAnchor
  rect: Rect
}

/**
 * Resolve every auto label on the map. Returns one entry per visible, unpinned,
 * named station; pinned labels are returned with their stored anchor so callers can
 * treat the result as the single source of truth for where labels are.
 */
export function placeLabels(
  project: Project,
  network: Network,
  space: Space,
): Map<StationId, Placed> {
  const result = new Map<StationId, Placed>()
  const { fontSize, stationRadius } = project.style
  const stations = stationMap(project)

  // Track geometry, collected once, for the overlap test — offset into the corridor and
  // carrying its half-width, because that is the ink a label has to stay off. Testing
  // the bare centreline let labels settle neatly onto the parallel track next to it.
  const track: { a: Vec2; b: Vec2; half: number }[] = []
  for (const line of project.lines) {
    if (line.hidden) continue
    const half = (modeById(project.modes, line.mode).strokeWidth * project.style.strokeScale) / 2
    for (const branch of line.branches) {
      const geom = branchGeometry(project, network, line, branch, space, stations)
      if (!geom) continue
      const pts = offsetPolyline(geom.points, geom.offsets)
      for (let i = 0; i < pts.length - 1; i++) {
        track.push({ a: pts[i], b: pts[i + 1], half })
      }
    }
  }

  // Route badges are drawn on the map too, so they are seeded as obstacles before any
  // label is placed. Without this, a terminus badge and its station label land in the
  // same spot — which is exactly where both want to go.
  const taken: Rect[] = []
  if (project.view.showLineBadges) {
    const bfs = fontSize * 0.86
    for (const b of lineBadges(project, network, space)) {
      const w = Math.max(bfs * 1.5, b.text.length * bfs * 0.62) + bfs * 0.7
      const h = bfs * 1.7
      taken.push({ x: b.at.x - w / 2, y: b.at.y - h / 2, w, h })
    }
  }

  // So is the furniture. A legend or a title block is opaque and is drawn last, so a
  // label that lands under one is simply gone — and nothing about that is visible while
  // composing, only in the finished file.
  if (project.view.showPlacements) {
    for (const pl of project.placements) {
      if (pl.hidden) continue
      const { w, h } = placementDrawnExtent(project, pl)
      if (w <= 0 || h <= 0) continue
      taken.push({ x: pl[space].x - w / 2, y: pl[space].y - h / 2, w, h })
    }
  }

  // Interchanges first — they are the labels a reader looks for, so they get first pick.
  const order = project.stations
    .filter((s) => s.name && !s.label.hidden)
    .sort((a, b) => {
      const ca = network.linesAtStation.get(a.id)?.length ?? 0
      const cb = network.linesAtStation.get(b.id)?.length ?? 0
      if (ca !== cb) return cb - ca
      return a.name.localeCompare(b.name)
    })

  for (const s of order) {
    const isInterchange = (network.linesAtStation.get(s.id)?.length ?? 0) > 1
    const gap = (isInterchange ? stationRadius * 1.45 : stationRadius) + 5
    const extra = labelExtras(project, s)

    if (s.label.pinned && s.label.anchor !== 'auto') {
      result.set(s.id, { anchor: s.label.anchor, lift: 0 })
      taken.push(labelRect(s[space], s.label.anchor, s.name, fontSize, gap, s.label.offset, extra))
      continue
    }

    let bestAnchor: LabelAnchor = 'e'
    let bestLift = 0
    let bestCost = Infinity
    let bestRect: Rect | null = null

    // Two rings. The near one is where a label belongs; the far one is the escape a
    // printed map takes when the near one is full, and it costs enough that it is only
    // ever taken when everything close by is genuinely worse.
    const rings = [0, fontSize * 1.9]
    for (let r = 0; r < rings.length; r++) {
      const lift = rings[r]
    for (let i = 0; i < CANDIDATES.length; i++) {
      const anchor = CANDIDATES[i]
      const rect = labelRect(s[space], anchor, s.name, fontSize, gap + lift, { x: 0, y: 0 }, extra)
      let cost = i * COST_ORDER + (lift > 0 ? COST_LIFT : 0)

      for (const t of taken) {
        if (overlaps(rect, t)) cost += COST_LABEL_OVERLAP
      }
      // Every line crossed costs, not just the first: a label lying over three tracks
      // is worse than one clipping a single branch, and the placer has to be able to
      // tell them apart to choose between two bad options.
      let crossed = 0
      for (const t of track) {
        // Only segments plausibly near this station can matter.
        if (dist(s[space], t.a) > 220 && dist(s[space], t.b) > 220) continue
        const ink = {
          x: rect.x - t.half,
          y: rect.y - t.half,
          w: rect.w + t.half * 2,
          h: rect.h + t.half * 2,
        }
        if (rectHitsSegment(ink, t.a, t.b)) crossed++
        if (crossed >= 3) break
      }
      cost += crossed * COST_TRACK_OVERLAP
      for (const other of project.stations) {
        if (other.id === s.id) continue
        const p = other[space]
        if (dist(s[space], p) > 200) continue
        if (
          p.x > rect.x - 4 &&
          p.x < rect.x + rect.w + 4 &&
          p.y > rect.y - 4 &&
          p.y < rect.y + rect.h + 4
        ) {
          cost += COST_STATION_OVERLAP
          break
        }
      }

      if (cost < bestCost) {
        bestCost = cost
        bestAnchor = anchor
        bestLift = lift
        bestRect = rect
      }
      // A clean spot on the near ring; nothing further out can beat it.
      if (cost === i * COST_ORDER && lift === 0) {
        r = rings.length
        break
      }
    }
    }

    result.set(s.id, { anchor: bestAnchor, lift: bestLift })
    if (bestRect) taken.push(bestRect)
  }

  return result
}

/**
 * Every label's box, resolved. The one place that knows how big the lettering on a map
 * is, so the export can size a page around it: a label is content, and a name hanging
 * off the westernmost station used to be sliced in half by the edge of the exported
 * file because only the dots were measured.
 */
export function labelRects(project: Project, network: Network, space: Space): Rect[] {
  const anchors = placeLabels(project, network, space)
  const { fontSize, stationRadius } = project.style
  const out: Rect[] = []
  for (const s of project.stations) {
    if (!s.name || s.label.hidden) continue
    const isInterchange = (network.linesAtStation.get(s.id)?.length ?? 0) > 1
    const gap = (isInterchange ? stationRadius * 1.45 : stationRadius) + 5
    const placed = anchors.get(s.id)
    out.push(
      labelRect(
        s[space],
        placed?.anchor ?? 'e',
        s.name,
        fontSize,
        gap + (placed?.lift ?? 0),
        s.label.offset,
        labelExtras(project, s),
      ),
    )
  }
  return out
}
