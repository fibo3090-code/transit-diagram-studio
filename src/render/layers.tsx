/**
 * Every drawing layer on the map surface.
 *
 * Layers are pure: they take a project, a derived network and a space, and draw. All
 * interaction lives in `MapView`, which passes callbacks down. Keeping it split this
 * way is what lets the exporter clone the live DOM and get a clean poster out of it.
 */

import { useEffect, useMemo, useState } from 'react'

import { modeById } from '../domain/defaults'
import {
  add,
  mul,
  offsetPolyline,
  sub,
  polygonPath,
  polylinePath,
  dist,
} from '../domain/geometry'
import { labelRect, placeLabels } from '../domain/labels'
import {
  branchGeometry,
  segmentKey,
  stationMap,
  type Network,
  type Space,
} from '../domain/network'
import type { GuideLine } from '../domain/snapping'
import { findCrossings, type Crossing } from '../domain/crossings'
import { lineBadges, stationSymbol } from '../domain/symbols'
import type {
  ImageId,
  LabelAnchor,
  LineId,
  Project,
  Station,
  StationId,
  TerrainId,
  Vec2,
} from '../domain/types'
import { blobUrl } from '../persistence/idb'

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export function ScreenshotLayer({
  project,
  selected,
  onPointerDown,
}: {
  project: Project
  selected: Set<ImageId>
  onPointerDown: (e: React.PointerEvent, id: ImageId) => void
}) {
  const [urls, setUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, string> = {}
      for (const img of project.images) {
        const url = await blobUrl(img.blobKey)
        if (url) next[img.blobKey] = url
      }
      if (!cancelled) setUrls(next)
    })()
    return () => {
      cancelled = true
    }
  }, [project.images])

  return (
    <g data-layer="screenshots">
      {project.images.map((img) => {
        if (img.hidden) return null
        const url = urls[img.blobKey]
        const isSel = selected.has(img.id)
        return (
          <g key={img.id}>
            {url ? (
              <image
                href={url}
                x={img.x}
                y={img.y}
                width={img.width}
                height={img.height}
                opacity={img.opacity * project.view.screenshotOpacity}
                preserveAspectRatio="none"
                onPointerDown={(e) => onPointerDown(e, img.id)}
                style={{ cursor: img.locked ? 'not-allowed' : 'move' }}
              />
            ) : (
              <rect
                x={img.x}
                y={img.y}
                width={img.width}
                height={img.height}
                fill="#E2E8F0"
                stroke="#94A3B8"
                strokeDasharray="6 4"
              />
            )}
            {isSel && (
              <rect
                x={img.x}
                y={img.y}
                width={img.width}
                height={img.height}
                fill="none"
                stroke="#2563EB"
                strokeWidth={2}
                pointerEvents="none"
                data-ui="selection"
              />
            )}
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

const TERRAIN_STYLE: Record<string, { fill?: string; stroke?: string; width?: number }> = {
  water: { fill: '#BFDCE8' },
  waterway: { stroke: '#BFDCE8', width: 10 },
  green: { fill: '#CFE3C4' },
  builtup: { fill: '#EDEAE4' },
  boundary: { stroke: '#B9B2A6', width: 1.5 },
  label: {},
}

export function TerrainLayer({
  project,
  space,
  selected,
  onPointerDown,
}: {
  project: Project
  space: Space
  selected: Set<TerrainId>
  onPointerDown: (e: React.PointerEvent, id: TerrainId) => void
}) {
  return (
    <g data-layer="terrain">
      {project.terrain.map((t) => {
        if (t.hidden) return null
        const pts = t[space]
        if (pts.length === 0) return null
        const style = TERRAIN_STYLE[t.kind] ?? {}
        const isSel = selected.has(t.id)
        const hit = (e: React.PointerEvent) => onPointerDown(e, t.id)

        if (t.kind === 'label') {
          return (
            <text
              key={t.id}
              x={pts[0].x}
              y={pts[0].y}
              fontSize={project.style.fontSize * 1.4}
              fontFamily={project.style.fontFamily}
              fill={project.style.foreground}
              opacity={0.45}
              textAnchor="middle"
              onPointerDown={hit}
              style={{ cursor: 'move' }}
            >
              {t.name}
            </text>
          )
        }

        const isFilled = t.closed && style.fill
        return (
          <g key={t.id}>
            {isFilled ? (
              <path d={polygonPath(pts)} fill={style.fill} stroke="none" onPointerDown={hit} />
            ) : (
              <path
                d={polylinePath(pts, 0)}
                fill="none"
                stroke={style.stroke ?? '#BFDCE8'}
                strokeWidth={style.width ?? 8}
                strokeLinecap="round"
                strokeLinejoin="round"
                onPointerDown={hit}
              />
            )}
            {isSel && (
              <path
                d={t.closed ? polygonPath(pts) : polylinePath(pts, 0)}
                fill="none"
                stroke="#2563EB"
                strokeWidth={2}
                strokeDasharray="5 4"
                pointerEvents="none"
                data-ui="selection"
              />
            )}
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface SegmentHit {
  lineId: LineId
  branchId: string
  a: StationId
  b: StationId
  /** Index of the from-stop within the branch's surviving stops. */
  stopIndex: number
}

export function LinesLayer({
  project,
  network,
  space,
  selectedLines,
  onLinePointerDown,
  onSegmentPointerDown,
  onCrossingPointerDown,
}: {
  project: Project
  network: Network
  space: Space
  selectedLines: Set<string>
  onLinePointerDown: (e: React.PointerEvent, lineId: LineId) => void
  onSegmentPointerDown: (e: React.PointerEvent, hit: SegmentHit) => void
  onCrossingPointerDown: (e: React.PointerEvent, key: string) => void
}) {
  const stations = useMemo(() => stationMap(project), [project])
  const scale = project.style.strokeScale

  // Geometry is computed once and reused for the stroke, the crossings and the hit
  // areas, so the three can never disagree about where a line runs.
  const rendered = useMemo(() => {
    const ordered = [...project.lines].sort(
      (a, b) => modeById(project.modes, a.mode).z - modeById(project.modes, b.mode).z,
    )
    return ordered
      .filter((l) => !l.hidden)
      .map((line, z) => {
        const mode = modeById(project.modes, line.mode)
        const width = mode.strokeWidth * project.style.strokeScale
        const branches = line.branches
          .map((branch) => {
            const geom = branchGeometry(project, network, line, branch, space, stations)
            if (!geom) return null
            const pts = offsetPolyline(geom.points, geom.offsets)
            // Each drawn sub-segment remembers which stop pair produced it, which is
            // what gives a crossing an identity that survives moving the stations.
            const segments = []
            for (let k = 0; k < geom.stopIndices.length - 1; k++) {
              const from = geom.stopIndices[k]
              const to = geom.stopIndices[k + 1]
              const sk = segmentKey(geom.stops[k], geom.stops[k + 1]) as string
              for (let j = from; j < to; j++) {
                segments.push({ a: pts[j], b: pts[j + 1], segKey: sk })
              }
            }
            return {
              branch,
              geom,
              pts,
              segments,
              path: polylinePath(pts, project.style.cornerRadius),
            }
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
        return { line, mode, width, z, branches }
      })
  }, [project, network, space, stations])

  // Bridges are grouped by the line that carries them so each can be drawn immediately
  // before that line's own stroke — which is what leaves the upper line continuous and
  // the lower one broken.
  const bridges = useMemo(() => {
    const found = findCrossings(
      rendered.map((r) => ({
        id: r.line.id,
        z: r.z,
        width: r.width,
        segments: r.branches.flatMap((b) => b.segments),
      })),
      project.stations.map((st) => st[space]),
      // A crossing this close to a station is a junction, not an overpass.
      project.style.stationRadius * 2.2 + project.style.corridorSpacing * 0.5,
      {
        length: project.style.casingLength * scale,
        height: project.style.casingHeight * scale,
        overrides: project.crossings,
      },
    )
    const byLine = new Map<string, Crossing[]>()
    for (const c of found) byLine.set(c.upper, [...(byLine.get(c.upper) ?? []), c])
    return byLine
  }, [rendered, project.stations, project.style, project.crossings, space, scale])

  return (
    <g data-layer="lines">
      {rendered.map(({ line, mode, width, branches }) => {
        const selected = selectedLines.has(line.id)
        const dash = mode.dash?.map((x) => x * project.style.strokeScale).join(' ')
        const mine = bridges.get(line.id) ?? []

        return (
          <g key={line.id} data-line={line.id} data-line-name={line.name}>
            {selected &&
              branches.map((d) => (
                <path
                  key={`sel-${d.branch.id}`}
                  d={d.path}
                  fill="none"
                  stroke={line.color}
                  strokeOpacity={0.28}
                  strokeWidth={width + 10}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pointerEvents="none"
                  data-ui="selection"
                />
              ))}

            {/* Break whatever this line passes over, at the crossing point only. */}
            {mine.map((c) => (
              <rect
                key={`bridge-${c.key}`}
                x={-c.length / 2}
                y={-c.height / 2}
                width={c.length}
                height={c.height}
                fill={project.style.background}
                transform={`translate(${c.at.x} ${c.at.y}) rotate(${
                  (Math.atan2(c.dir.y, c.dir.x) * 180) / Math.PI
                })`}
                pointerEvents="none"
                data-casing="true"
                data-crossing={c.key}
              />
            ))}

            {branches.map((d) => (
              <path
                key={`ink-${d.branch.id}`}
                d={d.path}
                fill="none"
                stroke={line.color}
                strokeWidth={width}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={dash}
                pointerEvents="none"
              />
            ))}

            {/* Clicking a crossing selects it, so its break can be tuned by hand. */}
            {mine.map((c) => (
              <rect
                key={`hit-${c.key}`}
                x={-Math.max(c.length, 14) / 2}
                y={-Math.max(c.height, 14) / 2}
                width={Math.max(c.length, 14)}
                height={Math.max(c.height, 14)}
                fill="transparent"
                transform={`translate(${c.at.x} ${c.at.y}) rotate(${
                  (Math.atan2(c.dir.y, c.dir.x) * 180) / Math.PI
                })`}
                data-ui="hit"
                style={{ cursor: 'pointer' }}
                onPointerDown={(e) => onCrossingPointerDown(e, c.key)}
              />
            ))}

            {/* Invisible per-segment hit areas. Generous width so a thin bus route is
                as easy to grab as a thick metro one. */}
            {branches.map((d) =>
              d.geom.stopIndices.slice(0, -1).map((startIdx, k) => {
                const endIdx = d.geom.stopIndices[k + 1]
                const sub2 = d.pts.slice(startIdx, endIdx + 1)
                if (sub2.length < 2) return null
                return (
                  <path
                    key={`${d.branch.id}-${k}`}
                    d={polylinePath(sub2, 0)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={Math.max(width + 8, 14)}
                    strokeLinecap="round"
                    data-ui="hit"
                    data-hit="segment"
                    onPointerDown={(e) => {
                      onLinePointerDown(e, line.id)
                      onSegmentPointerDown(e, {
                        lineId: line.id,
                        branchId: d.branch.id,
                        a: d.geom.stops[k],
                        b: d.geom.stops[k + 1],
                        stopIndex: k,
                      })
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                )
              }),
            )}
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Bend handles
// ---------------------------------------------------------------------------

export function BendHandlesLayer({
  project,
  space,
  selectedLines,
  zoom,
  onBendPointerDown,
}: {
  project: Project
  space: Space
  selectedLines: Set<string>
  zoom: number
  onBendPointerDown: (
    e: React.PointerEvent,
    lineId: LineId,
    key: string,
    index: number,
  ) => void
}) {
  if (selectedLines.size === 0) return null
  const r = 5 / zoom

  return (
    <g data-layer="bends" data-ui="selection">
      {project.lines.map((line) => {
        if (!selectedLines.has(line.id)) return null
        return Object.entries(line.bends).flatMap(([key, list]) =>
          list.map((bend, i) => (
            <circle
              key={`${key}-${i}`}
              cx={bend[space].x}
              cy={bend[space].y}
              r={r}
              fill="#FFFFFF"
              stroke={line.color}
              strokeWidth={2 / zoom}
              onPointerDown={(e) => onBendPointerDown(e, line.id, key, i)}
              style={{ cursor: 'grab' }}
            />
          )),
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export function StationsLayer({
  project,
  network,
  space,
  selected,
  onPointerDown,
}: {
  project: Project
  network: Network
  space: Space
  selected: Set<StationId>
  onPointerDown: (e: React.PointerEvent, id: StationId) => void
}) {
  const fg = project.style.foreground
  const bg = project.style.background
  const sw = 2.5 * project.style.strokeScale

  return (
    <g data-layer="stations">
      {project.stations.map((s: Station) => {
        const pos = s[space]
        const sym = stationSymbol(project, network, s, space)
        const isSelected = selected.has(s.id)
        const hitR = Math.max(
          sym.shape.kind === 'bar' ? sym.shape.halfLength : (sym.shape as { radius: number }).radius,
          12,
        )

        return (
          <g
            key={s.id}
            data-station={s.id}
            data-station-name={s.name}
            data-station-lines={(network.linesAtStation.get(s.id) ?? []).join(' ')}
            transform={`translate(${pos.x} ${pos.y})`}
            onPointerDown={(e) => onPointerDown(e, s.id)}
            style={{ cursor: 'grab' }}
          >
            {isSelected && (
              <circle
                r={hitR + 5}
                fill="none"
                stroke="#2563EB"
                strokeWidth={2}
                data-ui="selection"
              />
            )}
            <circle r={hitR} fill="transparent" data-ui="hit" />

            {sym.shape.kind === 'bar' && (
              <g
                transform={`rotate(${(Math.atan2(sym.shape.dir.y, sym.shape.dir.x) * 180) / Math.PI})`}
              >
                <rect
                  x={-sym.shape.halfLength}
                  y={-sym.shape.thickness / 2}
                  width={sym.shape.halfLength * 2}
                  height={sym.shape.thickness}
                  rx={sym.shape.thickness / 2}
                  fill={bg}
                  stroke={fg}
                  strokeWidth={sw}
                />
              </g>
            )}

            {sym.shape.kind === 'interchange' && (
              <circle r={sym.shape.radius} fill={bg} stroke={fg} strokeWidth={sw} />
            )}

            {sym.shape.kind === 'plain' && (
              <PlainSymbol shape={sym.shape} bg={bg} sw={sw} />
            )}

            {sym.shape.kind === 'orphan' && (
              <circle r={sym.shape.radius} fill={fg} opacity={0.25} />
            )}
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const ANCHOR_DIR: Record<LabelAnchor, Vec2> = {
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

export function LabelsLayer({
  project,
  network,
  space,
  onPointerDown,
}: {
  project: Project
  network: Network
  space: Space
  onPointerDown: (e: React.PointerEvent, id: StationId) => void
}) {
  const { fontSize, fontFamily, foreground, background, stationRadius } = project.style

  // Recomputed whenever the network or positions change. Cheap enough at map scale,
  // and it means labels reflow the moment you move a station rather than going stale.
  const anchors = useMemo(
    () => (project.view.autoLabels ? placeLabels(project, network, space) : new Map()),
    [project, network, space],
  )

  if (!project.view.showLabels) return null

  return (
    <g data-layer="labels">
      {project.stations.map((s) => {
        if (s.label.hidden || !s.name) return null
        const resolved: LabelAnchor =
          s.label.pinned && s.label.anchor !== 'auto'
            ? s.label.anchor
            : (anchors.get(s.id) ?? (s.label.anchor === 'auto' ? 'e' : s.label.anchor))

        const dir = ANCHOR_DIR[resolved] ?? ANCHOR_DIR.e
        const isInterchange = (network.linesAtStation.get(s.id)?.length ?? 0) > 1
        const gap = (isInterchange ? stationRadius * 1.45 : stationRadius) + 5
        const pos = s[space]
        const x = pos.x + dir.x * gap + s.label.offset.x
        const y = pos.y + dir.y * gap + s.label.offset.y

        const textAnchor = dir.x > 0.3 ? 'start' : dir.x < -0.3 ? 'end' : 'middle'
        const dy = dir.y > 0.3 ? '0.85em' : dir.y < -0.3 ? '-0.2em' : '0.32em'

        return (
          <text
            key={s.id}
            x={x}
            y={y}
            dy={dy}
            textAnchor={textAnchor}
            fontSize={fontSize}
            fontFamily={fontFamily}
            fontWeight={isInterchange ? 600 : 500}
            fill={foreground}
            stroke={background}
            strokeWidth={3}
            paintOrder="stroke"
            transform={s.label.angle ? `rotate(${s.label.angle} ${x} ${y})` : undefined}
            onPointerDown={(e) => onPointerDown(e, s.id)}
            style={{ cursor: 'move' }}
          >
            {s.name}
          </text>
        )
      })}
    </g>
  )
}

/** Bounding boxes of the resolved labels — used by export to size the page. */
export function labelBounds(project: Project, network: Network, space: Space) {
  const anchors = placeLabels(project, network, space)
  const rects = []
  for (const s of project.stations) {
    if (!s.name || s.label.hidden) continue
    const anchor = anchors.get(s.id) ?? 'e'
    const isInterchange = (network.linesAtStation.get(s.id)?.length ?? 0) > 1
    const gap = (isInterchange ? project.style.stationRadius * 1.45 : project.style.stationRadius) + 5
    rects.push(labelRect(s[space], anchor, s.name, project.style.fontSize, gap, s.label.offset))
  }
  return rects
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export function GhostLayer({ project, space }: { project: Project; space: Space }) {
  if (!project.view.showGeoGhosts || space !== 'schematic') return null
  return (
    <g data-layer="ghosts" pointerEvents="none">
      {project.stations.map((s) =>
        dist(s.geo, s.schematic) < 1 ? null : (
          <g key={s.id}>
            <line
              x1={s.schematic.x}
              y1={s.schematic.y}
              x2={s.geo.x}
              y2={s.geo.y}
              stroke="#94A3B8"
              strokeWidth={1}
              strokeDasharray="3 4"
              opacity={0.6}
            />
            <circle cx={s.geo.x} cy={s.geo.y} r={3} fill="#94A3B8" opacity={0.7} />
          </g>
        ),
      )}
    </g>
  )
}

const GUIDE_COLOR: Record<string, string> = {
  angle: '#2563EB',
  levels: '#7C3AED',
  align: '#DB2777',
  grid: '#64748B',
  spacing: '#059669',
}

export function GuidesLayer({ guides, zoom }: { guides: GuideLine[]; zoom: number }) {
  if (guides.length === 0) return null
  return (
    <g data-layer="guides" pointerEvents="none">
      {guides.map((g, i) => (
        <line
          key={i}
          x1={g.from.x}
          y1={g.from.y}
          x2={g.to.x}
          y2={g.to.y}
          stroke={GUIDE_COLOR[g.kind] ?? '#2563EB'}
          strokeWidth={1 / zoom}
          strokeDasharray={`${5 / zoom} ${5 / zoom}`}
          opacity={0.9}
        />
      ))}
    </g>
  )
}

/** In-progress terrain drawing and the marquee rectangle. */
export function DraftLayer({
  points,
  closed,
  marquee,
  cursor,
  zoom,
}: {
  points: Vec2[]
  closed: boolean
  marquee: { a: Vec2; b: Vec2 } | null
  /** Snapped pointer position while tracing, so you can see where the next point lands. */
  cursor?: Vec2 | null
  zoom: number
}) {
  return (
    <g data-layer="draft" pointerEvents="none">
      {points.length > 0 && (
        <>
          <path
            d={closed && points.length > 2 ? polygonPath(points) : polylinePath(points, 0)}
            fill={closed ? '#3B82F633' : 'none'}
            stroke="#2563EB"
            strokeWidth={2 / zoom}
            strokeDasharray={`${6 / zoom} ${4 / zoom}`}
          />
          {points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={3.5 / zoom} fill="#2563EB" />
          ))}
        </>
      )}

      {/* The segment about to be committed, drawn from the last point to the snapped
          cursor. Without it you are placing points blind and only see the result. */}
      {cursor && points.length > 0 && (
        <line
          x1={points[points.length - 1].x}
          y1={points[points.length - 1].y}
          x2={cursor.x}
          y2={cursor.y}
          stroke="#2563EB"
          strokeWidth={1.5 / zoom}
          strokeDasharray={`${4 / zoom} ${4 / zoom}`}
          opacity={0.7}
        />
      )}
      {cursor && (
        <circle
          cx={cursor.x}
          cy={cursor.y}
          r={4 / zoom}
          fill="#FFFFFF"
          stroke="#2563EB"
          strokeWidth={1.75 / zoom}
        />
      )}
      {marquee && (
        <rect
          x={Math.min(marquee.a.x, marquee.b.x)}
          y={Math.min(marquee.a.y, marquee.b.y)}
          width={Math.abs(marquee.b.x - marquee.a.x)}
          height={Math.abs(marquee.b.y - marquee.a.y)}
          fill="#3B82F61A"
          stroke="#2563EB"
          strokeWidth={1 / zoom}
        />
      )}
    </g>
  )
}

/** Grid dots, shown while composing so the snap pitch is visible. */
export function GridLayer({
  project,
  space,
  zoom,
  bounds,
}: {
  project: Project
  space: Space
  zoom: number
  bounds: { x: number; y: number; w: number; h: number }
}) {
  if (space !== 'schematic' || !project.view.showGrid || !project.snap.grid) return null
  const g = project.snap.gridSize
  if (g * zoom < 6) return null // Too dense to read; drawing it would just be noise.

  const startX = Math.floor(bounds.x / g) * g
  const startY = Math.floor(bounds.y / g) * g
  const dots: Vec2[] = []
  for (let x = startX; x < bounds.x + bounds.w; x += g) {
    for (let y = startY; y < bounds.y + bounds.h; y += g) {
      dots.push({ x, y })
      if (dots.length > 6000) break
    }
    if (dots.length > 6000) break
  }

  return (
    <g data-layer="grid" data-ui="chrome" pointerEvents="none">
      {dots.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={0.8 / zoom} fill={project.style.foreground} opacity={0.22} />
      ))}
    </g>
  )
}

export { add, mul }


// ---------------------------------------------------------------------------
// Station symbol shapes
// ---------------------------------------------------------------------------

/**
 * The symbol for a stop on a single line. Which shape is used comes from the line's
 * mode, so a rail halt reads differently from a tram stop without needing a legend.
 */
function PlainSymbol({
  shape,
  bg,
  sw,
}: {
  shape: Extract<ReturnType<typeof stationSymbol>['shape'], { kind: 'plain' }>
  bg: string
  sw: number
}) {
  const r = shape.radius
  const stroke = shape.color

  if (shape.symbol === 'tick') {
    // A short bar laid across the track, which is what most metro maps use.
    const angle = (Math.atan2(shape.across.y, shape.across.x) * 180) / Math.PI
    return (
      <g transform={`rotate(${angle})`}>
        <rect
          x={-r * 0.42}
          y={-r * 1.15}
          width={r * 0.84}
          height={r * 2.3}
          rx={r * 0.35}
          fill={bg}
          stroke={stroke}
          strokeWidth={sw * 0.85}
        />
      </g>
    )
  }

  if (shape.symbol === 'square') {
    return (
      <>
        <rect
          x={-r}
          y={-r}
          width={r * 2}
          height={r * 2}
          rx={r * 0.25}
          fill={bg}
          stroke={stroke}
          strokeWidth={sw}
        />
        {shape.filled && <rect x={-r * 0.4} y={-r * 0.4} width={r * 0.8} height={r * 0.8} fill={stroke} />}
      </>
    )
  }

  if (shape.symbol === 'diamond') {
    const d = `M 0 ${-r * 1.25} L ${r * 1.25} 0 L 0 ${r * 1.25} L ${-r * 1.25} 0 Z`
    return (
      <>
        <path d={d} fill={bg} stroke={stroke} strokeWidth={sw} />
        {shape.filled && <circle r={r * 0.4} fill={stroke} />}
      </>
    )
  }

  if (shape.symbol === 'anchor') {
    return (
      <>
        <circle r={r} fill={bg} stroke={stroke} strokeWidth={sw} />
        <path
          d={`M 0 ${-r * 0.55} V ${r * 0.5} M ${-r * 0.5} ${r * 0.1} Q 0 ${r * 0.85} ${r * 0.5} ${r * 0.1}`}
          fill="none"
          stroke={stroke}
          strokeWidth={sw * 0.7}
          strokeLinecap="round"
        />
      </>
    )
  }

  return (
    <>
      <circle r={r} fill={bg} stroke={stroke} strokeWidth={sw} />
      {shape.filled && <circle r={r * 0.45} fill={stroke} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Route badges
// ---------------------------------------------------------------------------

export function BadgeLayer({
  project,
  network,
  space,
}: {
  project: Project
  network: Network
  space: Space
}) {
  const badges = useMemo(
    () => (project.view.showLineBadges ? lineBadges(project, network, space) : []),
    [project, network, space],
  )
  if (badges.length === 0) return null

  const fs = project.style.fontSize * 0.86

  return (
    <g data-layer="badges" pointerEvents="none">
      {badges.map((b, i) => {
        const w = Math.max(fs * 1.5, b.text.length * fs * 0.62) + fs * 0.7
        const h = fs * 1.7
        return (
          <g key={`${b.lineId}-${i}`} transform={`translate(${b.at.x} ${b.at.y})`}>
            <rect
              x={-w / 2}
              y={-h / 2}
              width={w}
              height={h}
              rx={h / 2}
              fill={b.color}
            />
            <text
              y={0}
              dy="0.34em"
              textAnchor="middle"
              fontFamily={project.style.fontFamily}
              fontSize={fs}
              fontWeight={700}
              fill="#FFFFFF"
            >
              {b.text}
            </text>
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Terrain vertex handles
// ---------------------------------------------------------------------------

/**
 * Editable vertices for the selected terrain shapes, plus an invisible strip along each
 * edge so a click can add a corner where there wasn't one. This is what makes a traced
 * river reshapeable rather than a fixed blob you can only move or simplify.
 */
export function TerrainHandlesLayer({
  project,
  space,
  selected,
  zoom,
  onPointPointerDown,
  onEdgePointerDown,
}: {
  project: Project
  space: Space
  selected: Set<TerrainId>
  zoom: number
  onPointPointerDown: (e: React.PointerEvent, id: TerrainId, index: number) => void
  onEdgePointerDown: (
    e: React.PointerEvent,
    id: TerrainId,
    index: number,
    edge: { from: Vec2; to: Vec2 },
  ) => void
}) {
  if (selected.size === 0) return null
  const r = 4.5 / zoom

  return (
    <g data-layer="terrain-handles" data-ui="selection">
      {project.terrain.map((t) => {
        if (!selected.has(t.id) || t.hidden) return null
        const pts = t[space]
        if (pts.length === 0) return null

        const edges: { from: Vec2; to: Vec2; index: number }[] = []
        for (let i = 0; i < pts.length - 1; i++) {
          edges.push({ from: pts[i], to: pts[i + 1], index: i })
        }
        if (t.closed && pts.length > 2) {
          edges.push({ from: pts[pts.length - 1], to: pts[0], index: pts.length - 1 })
        }

        return (
          <g key={t.id}>
            {edges.map((e) => (
              <line
                key={`e${e.index}`}
                x1={e.from.x}
                y1={e.from.y}
                x2={e.to.x}
                y2={e.to.y}
                stroke="transparent"
                strokeWidth={14 / zoom}
                strokeLinecap="round"
                style={{ cursor: 'copy' }}
                onPointerDown={(ev) =>
                  onEdgePointerDown(ev, t.id, e.index, { from: e.from, to: e.to })
                }
              />
            ))}
            {pts.map((p, i) => (
              <circle
                key={`p${i}`}
                cx={p.x}
                cy={p.y}
                r={r}
                fill="#FFFFFF"
                stroke="#2563EB"
                strokeWidth={1.75 / zoom}
                style={{ cursor: 'grab' }}
                onPointerDown={(ev) => onPointPointerDown(ev, t.id, i)}
              />
            ))}
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Out-of-station interchanges
// ---------------------------------------------------------------------------

/**
 * The walking link between two separate stations, drawn the way real maps draw it: a
 * short dashed connector in the foreground ink, with a small gap at each end so it
 * reads as a link between two places rather than a line calling at both.
 */
export function TransferLayer({
  project,
  space,
  selected,
  onPointerDown,
}: {
  project: Project
  space: Space
  selected: Set<string>
  onPointerDown: (e: React.PointerEvent, id: string) => void
}) {
  if (project.transfers.length === 0) return null
  const byId = new Map(project.stations.map((s) => [s.id, s]))
  const fg = project.style.foreground
  const gap = project.style.stationRadius * 1.7

  return (
    <g data-layer="transfers">
      {project.transfers.map((t) => {
        if (t.hidden) return null
        const a = byId.get(t.a)
        const b = byId.get(t.b)
        if (!a || !b) return null

        const pa = a[space]
        const pb = b[space]
        const d = sub(pb, pa)
        const length = Math.hypot(d.x, d.y)
        if (length < gap * 2 + 2) return null
        const u = { x: d.x / length, y: d.y / length }
        const from = { x: pa.x + u.x * gap, y: pa.y + u.y * gap }
        const to = { x: pb.x - u.x * gap, y: pb.y - u.y * gap }
        const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
        const isSel = selected.has(t.id)

        return (
          <g key={t.id} data-transfer={t.id}>
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={project.style.background}
              strokeWidth={5}
              strokeLinecap="round"
            />
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={fg}
              strokeWidth={2}
              strokeDasharray="1 4"
              strokeLinecap="round"
              opacity={0.75}
            />
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="transparent"
              strokeWidth={14}
              data-ui="hit"
              style={{ cursor: 'pointer' }}
              onPointerDown={(e) => onPointerDown(e, t.id)}
            />
            {isSel && (
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="#2563EB"
                strokeWidth={4}
                strokeLinecap="round"
                opacity={0.5}
                data-ui="selection"
                pointerEvents="none"
              />
            )}
            {t.note && (
              <text
                x={mid.x}
                y={mid.y}
                dy="-0.5em"
                textAnchor="middle"
                fontFamily={project.style.fontFamily}
                fontSize={project.style.fontSize * 0.72}
                fill={fg}
                stroke={project.style.background}
                strokeWidth={2.5}
                paintOrder="stroke"
                opacity={0.85}
                pointerEvents="none"
              >
                {t.note}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Route highlight
// ---------------------------------------------------------------------------

/**
 * The planned journey, traced over the map as a translucent ribbon with a marker at
 * each end. Drawn above the network but below the stations, so the stops it calls at
 * stay readable through it.
 */
export function RouteLayer({
  project,
  space,
  path,
}: {
  project: Project
  space: Space
  path: StationId[]
}) {
  if (path.length < 2) return null
  const byId = new Map(project.stations.map((s) => [s.id, s]))
  const pts = path.map((id) => byId.get(id)?.[space]).filter((p): p is Vec2 => !!p)
  if (pts.length < 2) return null

  const width = project.style.stationRadius * 3.2

  return (
    <g data-layer="route" data-ui="chrome" pointerEvents="none">
      <path
        d={polylinePath(pts, project.style.cornerRadius)}
        fill="none"
        stroke="#2563EB"
        strokeOpacity={0.22}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {[pts[0], pts[pts.length - 1]].map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={project.style.stationRadius * 1.9}
          fill="none"
          stroke="#2563EB"
          strokeWidth={2.5}
        />
      ))}
    </g>
  )
}
