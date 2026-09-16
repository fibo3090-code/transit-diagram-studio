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

import { dist, rectHitsSegment } from './geometry'
import { branchGeometry, stationMap, type Network, type Space } from './network'
import { lineBadges } from './symbols'
import type { LabelAnchor, Project, StationId, Vec2 } from './types'

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

export function labelRect(
  pos: Vec2,
  anchor: LabelAnchor,
  text: string,
  fontSize: number,
  gap: number,
  offset: Vec2 = { x: 0, y: 0 },
): Rect {
  const d = DIR[anchor] ?? DIR.e
  const w = estimateTextWidth(text, fontSize)
  const h = fontSize * 1.15
  const cx = pos.x + d.x * (gap + w / 2) + offset.x
  const cy = pos.y + d.y * (gap + h / 2) + offset.y
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

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
): Map<StationId, LabelAnchor> {
  const result = new Map<StationId, LabelAnchor>()
  const { fontSize, stationRadius } = project.style
  const stations = stationMap(project)

  // Track geometry, collected once, for the overlap test.
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

    if (s.label.pinned && s.label.anchor !== 'auto') {
      result.set(s.id, s.label.anchor)
      taken.push(labelRect(s[space], s.label.anchor, s.name, fontSize, gap, s.label.offset))
      continue
    }

    let bestAnchor: LabelAnchor = 'e'
    let bestCost = Infinity
    let bestRect: Rect | null = null

    for (let i = 0; i < CANDIDATES.length; i++) {
      const anchor = CANDIDATES[i]
      const rect = labelRect(s[space], anchor, s.name, fontSize, gap)
      let cost = i * COST_ORDER

      for (const t of taken) {
        if (overlaps(rect, t)) cost += COST_LABEL_OVERLAP
      }
      for (const [p1, p2] of track) {
        // Only segments plausibly near this station can matter.
        if (dist(s[space], p1) > 220 && dist(s[space], p2) > 220) continue
        if (rectHitsSegment(rect, p1, p2)) {
          cost += COST_TRACK_OVERLAP
          break
        }
      }
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
        bestRect = rect
      }
      if (cost === i * COST_ORDER) break // A clean spot; nothing later can beat it.
    }

    result.set(s.id, bestAnchor)
    if (bestRect) taken.push(bestRect)
  }

  return result
}
