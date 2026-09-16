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
  polygonPathWithHoles,
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
  BadgeShape,
  ImageId,
  LabelAnchor,
  LineId,
  PlacementId,
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

/**
 * Resolve blob keys to object URLs.
 *
 * Shared by screenshots, the asset library and station symbols, because all three pull
 * their bytes from the same store and all three must cope with a key that has gone --
 * a missing url renders a placeholder rather than throwing.
 */
export function useBlobUrls(keys: string[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const joined = keys.join('|')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, string> = {}
      for (const key of joined ? joined.split('|') : []) {
        const url = await blobUrl(key)
        if (url) next[key] = url
      }
      if (!cancelled) setUrls(next)
    })()
    return () => {
      cancelled = true
    }
  }, [joined])

  return urls
}

export function ScreenshotLayer({
  project,
  selected,
  onPointerDown,
}: {
  project: Project
  selected: Set<ImageId>
  onPointerDown: (e: React.PointerEvent, id: ImageId) => void
}) {
  const urls = useBlobUrls(project.images.map((i) => i.blobKey))

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
  zone: { fill: 'rgba(37,99,235,0.07)' },
  label: {},
}

/**
 * Fill patterns for terrain.
 *
 * Defined once as SVG defs and referenced by url(), so the same hatch serves every
 * shape and the export carries them along with the rest of the surface.
 */
export function TerrainPatterns() {
  return (
    <defs>
      <pattern id="tds-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" opacity="0.35" />
      </pattern>
      <pattern id="tds-stipple" width="5" height="5" patternUnits="userSpaceOnUse">
        <circle cx="1.5" cy="1.5" r="0.7" fill="currentColor" opacity="0.35" />
      </pattern>
    </defs>
  )
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
          const ts = t.text ?? {}
          const size = (ts.size ?? project.style.fontSize * 1.4)
          return (
            <text
              key={t.id}
              x={pts[0].x}
              y={pts[0].y}
              fontSize={size}
              fontFamily={project.style.fontFamily}
              fontWeight={ts.weight ?? 400}
              fontStyle={ts.italic ? 'italic' : undefined}
              letterSpacing={ts.letterSpacing ?? undefined}
              fill={ts.color ?? project.style.foreground}
              opacity={ts.opacity ?? 0.45}
              textAnchor={ts.align ?? 'middle'}
              transform={ts.angle ? `rotate(${ts.angle} ${pts[0].x} ${pts[0].y})` : undefined}
              onPointerDown={hit}
              style={{ cursor: 'move' }}
            >
              {t.name}
            </text>
          )
        }

        const holes = t.holes.map((h) => h[space]).filter((r) => r.length >= 3)
        const closedPath = t.closed ? polygonPathWithHoles(pts, holes) : polylinePath(pts, 0)
        const isFilled = t.closed && t.fill !== 'none' && (style.fill || t.kind === 'zone')
        const patternId =
          t.fill === 'hatch' ? 'tds-hatch' : t.fill === 'stipple' ? 'tds-stipple' : null
        const flat = t.kind === 'zone' ? 'rgba(37,99,235,0.07)' : style.fill

        return (
          <g key={t.id}>
            {isFilled ? (
              <>
                <path
                  d={closedPath}
                  fill={flat}
                  fillRule="evenodd"
                  stroke="none"
                  onPointerDown={hit}
                />
                {patternId && (
                  // The pattern rides on top of the flat wash rather than replacing it,
                  // so a hatched park still reads as green when the hatch is fine.
                  <path
                    d={closedPath}
                    fill={`url(#${patternId})`}
                    fillRule="evenodd"
                    stroke="none"
                    pointerEvents="none"
                  />
                )}
              </>
            ) : (
              <path
                d={closedPath}
                fill="none"
                stroke={style.stroke ?? '#BFDCE8'}
                strokeWidth={style.width ?? 8}
                strokeLinecap="round"
                strokeLinejoin="round"
                onPointerDown={hit}
              />
            )}
            {t.kind === 'zone' && t.name && (
              <text
                x={pts[0].x}
                y={pts[0].y - 6}
                fontSize={project.style.fontSize}
                fontFamily={project.style.fontFamily}
                fill={project.style.foreground}
                opacity={0.5}
                pointerEvents="none"
              >
                {t.name}
              </text>
            )}
            {isSel && (
              <path
                d={closedPath}
                fill="none"
                fillRule="evenodd"
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
            // A bend marked `curve` sweeps instead of mitring. The flag has to be
            // mapped from bend order onto point order, because stops and passed
            // stations occupy the same array.
            const curved: boolean[] = new Array(pts.length).fill(false)
            {
              let at = 0
              const stopSet = new Set(geom.stopIndices)
              for (let j = 0; j < pts.length; j++) {
                if (stopSet.has(j)) continue
                at++
              }
              void at
            }
            for (const [key, list] of Object.entries(line.bends)) {
              void key
              for (const bend of list) {
                if (!bend.curve) continue
                // Match by position: the bend's own coordinate is already in `pts`.
                const idx = pts.findIndex((q) => dist(q, bend[space]) < 0.75)
                if (idx > 0 && idx < pts.length - 1) curved[idx] = true
              }
            }
            return {
              branch,
              geom,
              pts,
              segments,
              curved,
              path: polylinePath(pts, project.style.cornerRadius, curved),
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
                  stroke={d.branch.color ?? line.color}
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
                stroke={d.branch.color ?? line.color}
                strokeWidth={width}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={dash}
                pointerEvents="none"
              />
            ))}

            {/*
              One-way running gets an arrowhead at the midpoint of each drawn segment.
              Placed along the line rather than at its end, because a passenger needs to
              know which way a section runs, not only where it terminates.
            */}
            {project.view.showDirection &&
              branches
                .filter((d) => d.branch.direction === 'forward')
                .flatMap((d) =>
                  d.segments.map((seg, i) => {
                    if (i % 2 === 1) return null
                    const mx = (seg.a.x + seg.b.x) / 2
                    const my = (seg.a.y + seg.b.y) / 2
                    const ang = (Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x) * 180) / Math.PI
                    const h = Math.max(3, width * 0.42)
                    return (
                      <path
                        key={`dir-${d.branch.id}-${i}`}
                        d={`M ${-h} ${-h} L ${h * 0.9} 0 L ${-h} ${h} Z`}
                        fill={project.style.background}
                        opacity={0.9}
                        transform={`translate(${mx} ${my}) rotate(${ang})`}
                        pointerEvents="none"
                      />
                    )
                  }),
                )}

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
  const assetByKey = new Map(project.assets.map((a) => [a.id, a]))
  const symbolAssets = project.stations
    .map((s) => (s.symbol.kind === 'asset' ? assetByKey.get(s.symbol.assetId)?.blobKey : null))
    .filter((k): k is string => !!k)
  const urls = useBlobUrls(symbolAssets)

  return (
    <g data-layer="stations">
      {project.stations.map((s: Station) => {
        const pos = s[space]
        const sym = stationSymbol(project, network, s, space)
        const isSelected = selected.has(s.id)
        // The drawn mark stays small; the target around it does not. Pointing at a stop
        // should not require the precision of pointing at a 6px dot.
        const hitR = Math.max(
          sym.shape.kind === 'bar' ? sym.shape.halfLength : (sym.shape as { radius: number }).radius,
          project.style.hitRadius,
        )
        // Not yet open: drawn hollow and dashed, the convention every network uses for
        // something under construction.
        const pending = s.status !== 'open'
        const asset = s.symbol.kind === 'asset' ? assetByKey.get(s.symbol.assetId) : undefined
        const assetUrl = asset ? urls[asset.blobKey] : undefined

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

            {assetUrl && asset && s.symbol.kind === 'asset' && (
              <image
                href={assetUrl}
                x={(-asset.width * s.symbol.scale) / 2}
                y={(-asset.height * s.symbol.scale) / 2}
                width={asset.width * s.symbol.scale}
                height={asset.height * s.symbol.scale}
                preserveAspectRatio="xMidYMid meet"
              />
            )}

            {!assetUrl && pending && (
              <circle
                r={(sym.shape as { radius?: number }).radius ?? project.style.stationRadius}
                fill={bg}
                stroke={fg}
                strokeWidth={sw}
                strokeDasharray={`${sw * 1.6} ${sw * 1.4}`}
                opacity={s.status === 'planned' ? 0.55 : 0.8}
              />
            )}

            {!assetUrl && !pending && sym.shape.kind === 'bar' && (
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

            {!assetUrl && !pending && sym.shape.kind === 'interchange' && (
              <circle r={sym.shape.radius} fill={bg} stroke={fg} strokeWidth={sw} />
            )}

            {!assetUrl && !pending && sym.shape.kind === 'plain' && (
              <PlainSymbol shape={sym.shape} bg={bg} sw={sw} />
            )}

            {!assetUrl && !pending && sym.shape.kind === 'orphan' && (
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

/**
 * The small marks set beside a station name.
 *
 * Deliberately drawn as paths rather than emoji or an icon font: the export has to be a
 * self-contained SVG that opens anywhere, and a glyph that depends on the reader having
 * a font installed is not that.
 */
export const BUILTIN_BADGES = [
  { id: 'step-free', name: 'Step-free access' },
  { id: 'airport', name: 'Airport' },
  { id: 'rail', name: 'National rail' },
  { id: 'ferry', name: 'Ferry pier' },
  { id: 'bus', name: 'Bus station' },
  { id: 'park-ride', name: 'Park and ride' },
] as const

function StationBadge({
  id,
  x,
  size,
  fg,
  bg,
}: {
  id: string
  x: number
  size: number
  fg: string
  bg: string
}) {
  const r = size / 2
  const stroke = Math.max(0.8, size * 0.09)
  const glyph = () => {
    switch (id) {
      case 'step-free':
        // Wheelchair: head, back, wheel, footrest -- readable down to about 9px.
        return (
          <g fill="none" stroke={fg} strokeWidth={stroke} strokeLinecap="round">
            <circle cx={0} cy={-r * 0.52} r={r * 0.2} fill={fg} stroke="none" />
            <path d={`M ${-r * 0.1} ${-r * 0.22} v ${r * 0.5} h ${r * 0.45}`} />
            <circle cx={r * 0.04} cy={r * 0.42} r={r * 0.42} />
          </g>
        )
      case 'airport':
        return (
          <path
            d={`M ${-r * 0.72} ${r * 0.1} L ${r * 0.72} ${-r * 0.32} M ${-r * 0.1} ${-r * 0.5} L ${r * 0.2} ${-r * 0.2} M ${-r * 0.34} ${r * 0.52} L ${-r * 0.1} ${r * 0.16}`}
            fill="none"
            stroke={fg}
            strokeWidth={stroke * 1.3}
            strokeLinecap="round"
          />
        )
      case 'rail':
        return (
          <g fill="none" stroke={fg} strokeWidth={stroke} strokeLinecap="round">
            <path d={`M ${-r * 0.5} ${-r * 0.5} v ${r} M ${r * 0.5} ${-r * 0.5} v ${r}`} />
            <path d={`M ${-r * 0.75} ${-r * 0.16} h ${r * 1.5} M ${-r * 0.75} ${r * 0.2} h ${r * 1.5}`} />
          </g>
        )
      case 'ferry':
        return (
          <g fill="none" stroke={fg} strokeWidth={stroke} strokeLinecap="round">
            <path d={`M ${-r * 0.62} ${r * 0.24} h ${r * 1.24} l ${-r * 0.3} ${r * 0.42} h ${-r * 0.64} Z`} fill={fg} stroke="none" />
            <path d={`M 0 ${-r * 0.62} v ${r * 0.86} M ${-r * 0.34} ${-r * 0.3} h ${r * 0.68}`} />
          </g>
        )
      case 'bus':
        return (
          <g fill="none" stroke={fg} strokeWidth={stroke}>
            <rect x={-r * 0.6} y={-r * 0.6} width={r * 1.2} height={r * 1.1} rx={r * 0.25} />
            <path d={`M ${-r * 0.6} ${-r * 0.06} h ${r * 1.2}`} />
          </g>
        )
      default:
        return <circle r={r * 0.34} fill={fg} />
    }
  }
  return (
    <g transform={`translate(${x} 0)`}>
      <circle r={r} fill={bg} stroke={fg} strokeWidth={stroke} opacity={0.92} />
      {glyph()}
    </g>
  )
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

        const secondSize = fontSize * project.style.secondaryNameScale
        const badges = project.view.showBadges ? s.badges : []
        // Badges sit on the far side of the name from the stop, so they never collide
        // with the track, and they read as belonging to the label rather than the dot.
        const badgeX = textAnchor === 'end' ? x - 0 : x
        const badgeDir = textAnchor === 'end' ? -1 : 1

        return (
          <g key={s.id} transform={s.label.angle ? `rotate(${s.label.angle} ${x} ${y})` : undefined}>
            <text
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
              onPointerDown={(e) => onPointerDown(e, s.id)}
              style={{ cursor: 'move' }}
            >
              {s.name}
            </text>

            {s.nameSecondary && (
              <text
                x={x}
                y={y}
                dy={`calc(${dy} + ${secondSize * 1.15}px)`}
                textAnchor={textAnchor}
                fontSize={secondSize}
                fontFamily={fontFamily}
                fontWeight={400}
                fill={foreground}
                opacity={0.62}
                stroke={background}
                strokeWidth={2.5}
                paintOrder="stroke"
                onPointerDown={(e) => onPointerDown(e, s.id)}
                style={{ cursor: 'move' }}
              >
                {s.nameSecondary}
              </text>
            )}

            {badges.length > 0 && (
              <g transform={`translate(${badgeX} ${y})`} pointerEvents="none">
                {badges.map((b, i) => (
                  <StationBadge
                    key={b}
                    id={b}
                    x={badgeDir * (i * (fontSize * 0.92) + fontSize * 0.55)}
                    size={fontSize * 0.78}
                    fg={foreground}
                    bg={background}
                  />
                ))}
              </g>
            )}

            {s.zone && project.view.showZones && (
              <text
                x={x}
                y={y}
                dy={`calc(${dy} - ${fontSize * 0.95}px)`}
                textAnchor={textAnchor}
                fontSize={fontSize * 0.7}
                fontFamily={fontFamily}
                fill={foreground}
                opacity={0.5}
                pointerEvents="none"
              >
                {s.zone}
              </text>
            )}
          </g>
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

/**
 * The shape a route bullet takes.
 *
 * Networks are recognised by this as much as by their colours -- London's roundel,
 * New York's disc, Vienna's square. One hardcoded pill made every map look like the
 * same map.
 */
function RouteBullet({
  shape,
  w,
  h,
  color,
}: {
  shape: BadgeShape
  w: number
  h: number
  color: string
}) {
  const r = h / 2
  switch (shape) {
    case 'circle':
      return <circle r={r} fill={color} />
    case 'roundel': {
      // A bar across a ring. The bar has to clear the text that sits on it, so it is
      // sized from the mark's height rather than from the ring -- an earlier version
      // derived it from the ring radius and produced a 6px bar under 11px type, which
      // swallowed every line name on the map.
      const ring = h * 0.62
      const bar = h * 0.62
      // The bar has to reach PAST the ring or the mark reads as a plain disc -- which
      // is what a two-character line name produced, since its label is narrower than
      // the ring is wide.
      const span = Math.max(w, ring * 2.7)
      return (
        <g>
          <circle r={ring} fill="none" stroke={color} strokeWidth={ring * 0.4} />
          <rect x={-span / 2} y={-bar / 2} width={span} height={bar} fill={color} />
        </g>
      )
    }
    case 'square':
      return <rect x={-r} y={-r} width={r * 2} height={r * 2} fill={color} />
    case 'diamond':
      return <path d={`M 0 ${-r} L ${r} 0 L 0 ${r} L ${-r} 0 Z`} fill={color} />
    case 'hex': {
      const pts = [0, 1, 2, 3, 4, 5]
        .map((k) => {
          const a = (Math.PI / 3) * k - Math.PI / 6
          return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`
        })
        .join(' L ')
      return <path d={`M ${pts} Z`} fill={color} />
    }
    default:
      return <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill={color} />
  }
}

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
            <RouteBullet shape={project.style.badgeShape} w={w} h={h} color={b.color} />
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

// ---------------------------------------------------------------------------
// Placements — the map furniture
// ---------------------------------------------------------------------------

/**
 * Everything on the map that is not part of the network: markers cropped from the
 * source art, the legend, a north arrow, a scale bar, a title block, a frame.
 *
 * All of it carries both positions for the same reason a station does. A legend placed
 * on the diagram should not move because the geographic view was nudged.
 */
export function PlacementLayer({
  project,
  space,
  selected,
  onPointerDown,
}: {
  project: Project
  space: Space
  selected: Set<PlacementId>
  onPointerDown: (e: React.PointerEvent, id: PlacementId) => void
}) {
  const assetByKey = new Map(project.assets.map((a) => [a.id, a]))
  const keys = project.placements
    .map((pl) => (pl.what.kind === 'asset' ? assetByKey.get(pl.what.assetId)?.blobKey : null))
    .filter((k): k is string => !!k)
  const urls = useBlobUrls(keys)

  if (!project.view.showPlacements) return null
  const { foreground, background, fontFamily, fontSize } = project.style

  return (
    <g data-layer="placements">
      {project.placements.map((pl) => {
        if (pl.hidden) return null
        const at = pl[space]
        const isSel = selected.has(pl.id)
        const hit = (e: React.PointerEvent) => onPointerDown(e, pl.id)

        let body: React.ReactNode = null
        let w = 0
        let h = 0

        if (pl.what.kind === 'asset') {
          const a = assetByKey.get(pl.what.assetId)
          const url = a ? urls[a.blobKey] : undefined
          if (a) {
            w = a.width
            h = a.height
            body = url ? (
              <image href={url} x={-w / 2} y={-h / 2} width={w} height={h} />
            ) : (
              <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="none" stroke={foreground} strokeDasharray="4 3" opacity={0.4} />
            )
          }
        } else if (pl.what.kind === 'northArrow') {
          const r = 22
          w = h = r * 2
          body = (
            <g>
              <circle r={r} fill={background} stroke={foreground} strokeWidth={1.2} opacity={0.9} />
              <path d={`M 0 ${-r * 0.72} L ${r * 0.34} ${r * 0.5} L 0 ${r * 0.2} L ${-r * 0.34} ${r * 0.5} Z`} fill={foreground} />
              <text y={-r * 0.82} textAnchor="middle" fontSize={fontSize * 0.8} fontFamily={fontFamily} fill={foreground} fontWeight={700}>
                N
              </text>
            </g>
          )
        } else if (pl.what.kind === 'scaleBar') {
          const unit = 100
          w = unit * 2
          h = 18
          body = (
            <g>
              <rect x={-w / 2} y={-3} width={unit} height={6} fill={foreground} />
              <rect x={-w / 2 + unit} y={-3} width={unit} height={6} fill={background} stroke={foreground} strokeWidth={1} />
              <text x={-w / 2} y={18} fontSize={fontSize * 0.72} fontFamily={fontFamily} fill={foreground} textAnchor="middle">0</text>
              <text x={w / 2} y={18} fontSize={fontSize * 0.72} fontFamily={fontFamily} fill={foreground} textAnchor="middle">
                {pl.label ?? `${unit * 2}`}
              </text>
            </g>
          )
        } else if (pl.what.kind === 'legend') {
          // Derived from the project rather than stored, so it can never fall out of
          // step with the lines it describes -- the same rule the network follows.
          const rows = project.lines.filter((l) => !l.hidden)
          const rowH = fontSize * 1.75
          w = 210
          h = rowH * (rows.length + 1) + 12
          body = (
            <g>
              <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={8} fill={background} stroke={foreground} strokeOpacity={0.18} />
              <text x={-w / 2 + 12} y={-h / 2 + rowH * 0.9} fontSize={fontSize * 0.95} fontWeight={700} fontFamily={fontFamily} fill={foreground}>
                {pl.label ?? 'Legend'}
              </text>
              {rows.map((l, i) => {
                const mode = modeById(project.modes, l.mode)
                const y = -h / 2 + rowH * (i + 1.85)
                return (
                  <g key={l.id}>
                    <line
                      x1={-w / 2 + 12}
                      y1={y - fontSize * 0.3}
                      x2={-w / 2 + 44}
                      y2={y - fontSize * 0.3}
                      stroke={l.color}
                      strokeWidth={Math.min(6, mode.strokeWidth * 0.7)}
                      strokeLinecap="round"
                      strokeDasharray={mode.dash?.join(' ')}
                    />
                    <text x={-w / 2 + 54} y={y} fontSize={fontSize * 0.88} fontFamily={fontFamily} fill={foreground}>
                      {l.name}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        } else if (pl.what.kind === 'titleBlock') {
          w = 280
          h = 74
          body = (
            <g>
              <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={6} fill={background} stroke={foreground} strokeOpacity={0.18} />
              <text x={-w / 2 + 14} y={-h / 2 + 30} fontSize={fontSize * 1.5} fontWeight={700} fontFamily={fontFamily} fill={foreground}>
                {pl.label ?? project.name}
              </text>
              <text x={-w / 2 + 14} y={-h / 2 + 52} fontSize={fontSize * 0.82} fontFamily={fontFamily} fill={foreground} opacity={0.6}>
                {project.stations.length} stops · {project.lines.length} lines
              </text>
            </g>
          )
        } else if (pl.what.kind === 'frame') {
          w = 900
          h = 640
          body = (
            <g>
              <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="none" stroke={foreground} strokeWidth={3} opacity={0.75} />
              <rect x={-w / 2 + 9} y={-h / 2 + 9} width={w - 18} height={h - 18} fill="none" stroke={foreground} strokeWidth={1} opacity={0.4} />
            </g>
          )
        }

        return (
          <g
            key={pl.id}
            data-placement={pl.id}
            transform={`translate(${at.x} ${at.y}) rotate(${pl.angle}) scale(${pl.scale})`}
            opacity={pl.opacity}
            onPointerDown={pl.locked ? undefined : hit}
            style={{ cursor: pl.locked ? 'not-allowed' : 'move' }}
          >
            {body}
            {isSel && (
              <rect
                x={-w / 2 - 6}
                y={-h / 2 - 6}
                width={w + 12}
                height={h + 12}
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
