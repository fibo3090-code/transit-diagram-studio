/**
 * The map surface, used for BOTH spaces.
 *
 * The spec called for Canvas 2D in the geographic view and SVG in the schematic one.
 * They are unified here as a single SVG surface, because it collapses two renderers,
 * two hit-testing paths and two interaction models into one — and a handful of
 * screenshots under a GPU-composited transform pan and zoom perfectly well.
 *
 * Every gesture funnels through one `Gesture` union, so there is exactly one place
 * where a pointer move can change the project.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { boundsSize, closestOnSegment, dist, sub } from '../domain/geometry'
import { placeLabels } from '../domain/labels'
import { segmentKey, type Space } from '../domain/network'
import {
  snapPoint,
  spacingRefsFor,
  type GuideLine,
  type LevelGuide,
} from '../domain/snapping'
import { stationLevels } from '../domain/symbols'
import type {
  ImageId,
  LabelAnchor,
  LineId,
  PlacementId,
  StationId,
  TerrainId,
  TerrainKind,
  TransferId,
  Vec2,
} from '../domain/types'
import { contentBounds } from '../export/exporters'
import { cropAssetFromImages } from '../persistence/files'
import { networkOf, useEditor } from '../store/editor-store'
import {
  BadgeLayer,
  BendHandlesLayer,
  DraftLayer,
  GhostLayer,
  GridLayer,
  GuidesLayer,
  LabelsLayer,
  LinesLayer,
  ScreenshotLayer,
  RouteLayer,
  StationsLayer,
  TerrainHandlesLayer,
  PlacementLayer,
  TerrainLayer,
  TerrainPatterns,
  TransferLayer,
  type SegmentHit,
} from './layers'

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

type Gesture =
  | { kind: 'pan'; startClient: Vec2; startVp: Vec2 }
  | { kind: 'stations'; ids: StationId[]; primary: StationId; grabOffset: Vec2 }
  | { kind: 'bend'; lineId: LineId; key: string; index: number; grabOffset: Vec2 }
  | { kind: 'image'; id: ImageId; grabOffset: Vec2 }
  | { kind: 'placement'; ids: PlacementId[]; last: Vec2 }
  | { kind: 'terrain'; ids: TerrainId[]; last: Vec2 }
  | { kind: 'terrainPoint'; id: TerrainId; index: number; grabOffset: Vec2 }
  | { kind: 'label'; id: StationId; startOffset: Vec2; startWorld: Vec2 }
  | { kind: 'marquee'; a: Vec2; b: Vec2; additive: boolean }
  | null

export interface TerrainDraft {
  kind: TerrainKind
  points: Vec2[]
  closed: boolean
}

/** How close an image edge must come to another's before it snaps, in world units. */
const IMAGE_SNAP = 14

export function MapView() {
  const svgRef = useRef<SVGSVGElement | null>(null)
  // The view keeps refitting until the reader first moves it themselves.
  //
  // A single fit on mount is not enough: the surface is measured before the side
  // panels have taken their width, so the zoom is computed for a canvas wider than the
  // one that ends up on screen, and the map spills under the inspector. Refitting on
  // every size change until the first manual move fixes that without ever yanking the
  // view out from under someone who has started composing.
  const userMovedRef = useRef(false)
  const project = useEditor((s) => s.project)
  const space = useEditor((s) => s.space)
  const tool = useEditor((s) => s.tool)
  const selection = useEditor((s) => s.selection)
  const viewport = useEditor((s) => s.viewports[space])
  const snapSuspended = useEditor((s) => s.snapSuspended)
  const activeLineId = useEditor((s) => s.activeLineId)
  const activeBranchId = useEditor((s) => s.activeBranchId)
  const terrainKind = useEditor((s) => s.terrainKind)
  const route = useEditor((s) => s.route)
  const routePick = useEditor((s) => s.routePick)
  const setRouteEnd = useEditor((s) => s.setRouteEnd)
  const setRoutePick = useEditor((s) => s.setRoutePick)

  const setViewport = useEditor((s) => s.setViewport)
  const addStation = useEditor((s) => s.addStation)
  const appendStop = useEditor((s) => s.appendStop)
  const followTrack = useEditor((s) => s.followTrack)
  const select = useEditor((s) => s.select)
  const clearSelection = useEditor((s) => s.clearSelection)
  const mutate = useEditor((s) => s.mutate)
  const updateImage = useEditor((s) => s.updateImage)
  const setLabel = useEditor((s) => s.setLabel)
  const addBend = useEditor((s) => s.addBend)
  const moveBend = useEditor((s) => s.moveBend)
  const removeBend = useEditor((s) => s.removeBend)
  const addTerrain = useEditor((s) => s.addTerrain)
  const moveTerrain = useEditor((s) => s.moveTerrain)
  const movePlacements = useEditor((s) => s.movePlacements)
  const cropping = useEditor((s) => s.cropping)
  const setCropping = useEditor((s) => s.setCropping)
  const addAsset = useEditor((s) => s.addAsset)
  const moveTerrainPoint = useEditor((s) => s.moveTerrainPoint)
  const insertTerrainPoint = useEditor((s) => s.insertTerrainPoint)
  const removeTerrainPoint = useEditor((s) => s.removeTerrainPoint)
  const setTool = useEditor((s) => s.setTool)

  const [gesture, setGesture] = useState<Gesture>(null)
  const [guides, setGuides] = useState<GuideLine[]>([])
  const [draft, setDraft] = useState<TerrainDraft | null>(null)
  const [draftCursor, setDraftCursor] = useState<Vec2 | null>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })

  const network = project ? networkOf(project) : null

  // -- viewport helpers ----------------------------------------------------

  const toWorld = useCallback(
    (clientX: number, clientY: number): Vec2 => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      }
    },
    [viewport],
  )

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Zoom at the cursor, keeping the world point under it pinned.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * 0.0015)
      const zoom = Math.min(8, Math.max(0.02, viewport.zoom * factor))
      userMovedRef.current = true
      setViewport(space, {
        zoom,
        x: cx - ((cx - viewport.x) / viewport.zoom) * zoom,
        y: cy - ((cy - viewport.y) / viewport.zoom) * zoom,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewport, space, setViewport])

  // Zoom-to-fit, driven from the toolbar and the F key via a custom event.
  useEffect(() => {
    const fit = (target: 'all' | 'selection') => {
      if (!project) return
      let b = contentBounds(project, space, 40, network ?? undefined)
      if (target === 'selection' && selection.stations.length > 0) {
        const pts = project.stations
          .filter((s) => selection.stations.includes(s.id))
          .map((s) => s[space])
        if (pts.length > 0) {
          b = {
            minX: Math.min(...pts.map((p) => p.x)) - 80,
            minY: Math.min(...pts.map((p) => p.y)) - 80,
            maxX: Math.max(...pts.map((p) => p.x)) + 80,
            maxY: Math.max(...pts.map((p) => p.y)) + 80,
          }
        }
      }
      const { width, height } = boundsSize(b)
      if (width < 1 || height < 1) return
      const zoom = Math.min(8, Math.max(0.02, Math.min(size.w / width, size.h / height)))
      setViewport(space, {
        zoom,
        x: size.w / 2 - (b.minX + width / 2) * zoom,
        y: size.h / 2 - (b.minY + height / 2) * zoom,
      })
    }
    const onFit = (e: Event) => {
      userMovedRef.current = true
      fit((e as CustomEvent).detail === 'selection' ? 'selection' : 'all')
    }
    window.addEventListener('tds:fit', onFit)

    // Fit once, as soon as there is a project and a measured surface to fit it into.
    // Opening a map clipped and expecting the reader to know about the F key is a poor
    // first impression of a tool whose whole output is a picture.
    if (!userMovedRef.current && project && project.stations.length > 0 && size.w > 1 && size.h > 1) {
      fit('all')
    }

    return () => window.removeEventListener('tds:fit', onFit)
  }, [project, space, size, selection.stations, setViewport])

  // Escape cancels an in-progress terrain trace before it cancels the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!draft) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        setDraft(null)
        setDraftCursor(null)
        setGuides([])
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        commitDraft()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Leaving the terrain tool should take its preview and guides with it, or they hang
  // around over the map until something else happens to clear them.
  useEffect(() => {
    if (tool !== 'terrain') {
      setDraftCursor(null)
      setGuides((g) => (g.length ? [] : g))
    }
  }, [tool])

  const commitDraft = () => {
    if (!draft) return
    const min = draft.closed ? 3 : 2
    if (draft.points.length >= min) {
      addTerrain(draft.kind, draft.points, space, '', draft.closed)
    }
    setDraft(null)
    setDraftCursor(null)
    setGuides([])
    setTool('select')
  }

  const labelAnchors = useMemo(
    () => (project && network ? placeLabels(project, network, space) : new Map<StationId, LabelAnchor>()),
    [project, network, space],
  )

  if (!project || !network) return <div className="flex-1 bg-slate-100" />

  const selectedStations = new Set(selection.stations)
  const selectedLines = new Set<string>(selection.lines)
  const selectedCrossingSet = new Set<string>(selection.crossings)
  const selectedTerrain = new Set<TerrainId>(selection.terrain)
  const selectedImages = new Set<ImageId>(selection.images)
  const selectedPlacements = new Set<PlacementId>(selection.placements)
  const selectedTransfers = new Set<string>(selection.transfers)


  const capture = (e: React.PointerEvent) =>
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId)

  /**
   * Corridor levels from the stations nearest the cursor. Capped, because every level
   * becomes a constraint line and the snap engine compares them pairwise — the whole
   * map's worth would be quadratic for no benefit, since a distant track is not
   * something you are trying to line up with anyway.
   */
  const levelsNear = (at: Vec2, exclude?: StationId): LevelGuide[] => {
    if (!project.snap.levels) return []
    const near = project.stations
      .filter((st) => st.id !== exclude)
      .map((st) => ({ st, d: dist(st[space], at) }))
      .filter((x) => x.d < 600)
      .sort((a, b) => a.d - b.d)
      .slice(0, 8)
    return near.flatMap(({ st }) => stationLevels(project, network, st, space))
  }

  /**
   * Alignment candidates for terrain work: every station plus every other terrain
   * vertex nearby. A traced river should be able to line up with the network and with
   * itself, not just with the grid.
   */
  const terrainOthers = (at: Vec2, exclude?: { id: TerrainId; index: number }): Vec2[] => {
    const out: Vec2[] = []
    for (const st of project.stations) {
      if (dist(st[space], at) < 600) out.push(st[space])
    }
    for (const t of project.terrain) {
      if (t.hidden) continue
      t[space].forEach((q, i) => {
        if (exclude && t.id === exclude.id && i === exclude.index) return
        if (dist(q, at) < 600) out.push(q)
      })
    }
    return out.slice(0, 240)
  }

  /**
   * Snap a terrain point. `neighbours` are the vertices it is joined to, which is what
   * lets a river run at a clean 45° the same way a line does.
   */
  const snapTerrain = (
    raw: Vec2,
    neighbours: Vec2[],
    exclude?: { id: TerrainId; index: number },
  ): { point: Vec2; guides: GuideLine[] } => {
    if (snapSuspended) return { point: raw, guides: [] }
    const r = snapPoint({
      raw,
      neighbours,
      others: terrainOthers(raw, exclude),
      spacing: [],
      levels: levelsNear(raw),
      settings: project.snap,
    })
    return { point: r.point, guides: r.guides }
  }

  /** The vertices a draft's next point should take its angle guides from. */
  const draftNeighbours = (d: TerrainDraft | null): Vec2[] => {
    if (!d || d.points.length === 0) return []
    const out = [d.points[d.points.length - 1]]
    // Closing a polygon is easier when the first point also throws guides.
    if (d.closed && d.points.length > 2) out.push(d.points[0])
    return out
  }

  // -- station ------------------------------------------------------------

  const onStationPointerDown = (e: React.PointerEvent, id: StationId) => {
    e.stopPropagation()

    if (routePick) {
      setRouteEnd(routePick, id)
      setRoutePick(null)
      return
    }

    if (tool === 'line' && activeLineId && activeBranchId) {
      // Shift skips ahead along track that already exists rather than drawing a straight
      // hop over it — the difference between describing a service and re-clicking the
      // twenty stops it shares with the line beside it. Ctrl (or Cmd) with it makes
      // those stops pass-throughs, which is how an express gets drawn.
      if (e.shiftKey) {
        const ran = followTrack(activeLineId, activeBranchId, id, !(e.ctrlKey || e.metaKey))
        if (ran) return
      }
      appendStop(activeLineId, activeBranchId, id)
      return
    }
    if (tool === 'pan') return

    capture(e)
    const additive = e.shiftKey
    const already = selectedStations.has(id)
    const ids = additive || already ? [...new Set([...selection.stations, id])] : [id]
    select({ stations: ids })

    const station = project.stations.find((s) => s.id === id)!
    setGesture({
      kind: 'stations',
      ids,
      primary: id,
      grabOffset: sub(toWorld(e.clientX, e.clientY), station[space]),
    })
  }

  // -- label --------------------------------------------------------------

  const onLabelPointerDown = (e: React.PointerEvent, id: StationId) => {
    if (tool !== 'select') return
    e.stopPropagation()
    capture(e)
    const station = project.stations.find((s) => s.id === id)
    if (!station) return
    select({ stations: [id] })
    setGesture({
      kind: 'label',
      id,
      startOffset: { ...station.label.offset },
      startWorld: toWorld(e.clientX, e.clientY),
    })
  }

  // -- line + segment -----------------------------------------------------

  const onLinePointerDown = (e: React.PointerEvent, lineId: LineId) => {
    if (tool === 'line' || tool === 'station' || tool === 'pan') return
    e.stopPropagation()
    select({ lines: [lineId] })
  }

  const onSegmentPointerDown = (e: React.PointerEvent, hit: SegmentHit) => {
    if (tool !== 'bend') return
    e.stopPropagation()
    const world = toWorld(e.clientX, e.clientY)

    if (e.altKey) {
      const id = useEditor.getState().addStationOnSegment(
        hit.lineId,
        hit.branchId,
        hit.stopIndex,
        world,
        space,
      )
      if (id) select({ stations: [id] })
      return
    }

    // A bend is a point in BOTH spaces. The space you are not looking at gets the
    // midpoint of its own segment, so adding a corner here never distorts the other view.
    const a = project.stations.find((s) => s.id === hit.a)
    const b = project.stations.find((s) => s.id === hit.b)
    if (!a || !b) return
    const other: Space = space === 'geo' ? 'schematic' : 'geo'
    const mid = { x: (a[other].x + b[other].x) / 2, y: (a[other].y + b[other].y) / 2 }

    addBend(hit.lineId, hit.a, hit.b, 0, {
      geo: space === 'geo' ? world : mid,
      schematic: space === 'schematic' ? world : mid,
    })
    select({ lines: [hit.lineId] })
  }

  const onBendPointerDown = (
    e: React.PointerEvent,
    lineId: LineId,
    key: string,
    index: number,
  ) => {
    e.stopPropagation()
    if (e.altKey) {
      const [a, b] = key.split('|') as [StationId, StationId]
      removeBend(lineId, a, b, index)
      return
    }
    capture(e)
    const bend = project.lines.find((l) => l.id === lineId)?.bends[key]?.[index]
    if (!bend) return
    setGesture({
      kind: 'bend',
      lineId,
      key,
      index,
      grabOffset: sub(toWorld(e.clientX, e.clientY), bend[space]),
    })
  }

  // -- terrain + image ----------------------------------------------------

  const onTerrainPointerDown = (e: React.PointerEvent, id: TerrainId) => {
    if (tool !== 'select') return
    e.stopPropagation()
    capture(e)
    const ids = selection.terrain.includes(id) ? selection.terrain : [id]
    select({ terrain: ids })
    setGesture({ kind: 'terrain', ids, last: toWorld(e.clientX, e.clientY) })
  }

  const onTerrainPointPointerDown = (
    e: React.PointerEvent,
    id: TerrainId,
    index: number,
  ) => {
    e.stopPropagation()
    if (e.altKey) {
      removeTerrainPoint(id, index)
      return
    }
    capture(e)
    const t = project.terrain.find((x) => x.id === id)
    const p = t?.[space][index]
    if (!p) return
    setGesture({
      kind: 'terrainPoint',
      id,
      index,
      grabOffset: sub(toWorld(e.clientX, e.clientY), p),
    })
  }

  const onTerrainEdgePointerDown = (
    e: React.PointerEvent,
    id: TerrainId,
    index: number,
    edge: { from: Vec2; to: Vec2 },
  ) => {
    e.stopPropagation()
    // Project onto the edge so the new corner lands on the shape, not beside it.
    const at = closestOnSegment(toWorld(e.clientX, e.clientY), edge.from, edge.to)
    insertTerrainPoint(id, index, at, space)
  }

  const onCrossingPointerDown = (e: React.PointerEvent, key: string) => {
    if (tool !== 'select') return
    e.stopPropagation()
    // Shift adds, so a row of overpasses along one line can be tuned together.
    select({ crossings: [key] }, e.shiftKey)
  }

  const onTransferPointerDown = (e: React.PointerEvent, id: string) => {
    if (tool !== 'select') return
    e.stopPropagation()
    select({ transfers: [id as TransferId] })
  }

  const onPlacementPointerDown = (e: React.PointerEvent, id: PlacementId) => {
    if (tool !== 'select') return
    e.stopPropagation()
    capture(e)
    const already = selection.placements.includes(id)
    const ids = already && selection.placements.length > 1 ? selection.placements : [id]
    if (!already) select({ placements: [id] }, e.shiftKey)
    setGesture({ kind: 'placement', ids, last: toWorld(e.clientX, e.clientY) })
  }

  const onImagePointerDown = (e: React.PointerEvent, id: ImageId) => {
    // While a crop is armed the screenshots have to let the pointer through: the
    // surface owns the marquee, and this handler would otherwise stop propagation and
    // drag the very image the crop is trying to cut from.
    if (cropping) return
    if (tool !== 'select' || space !== 'geo') return
    const img = project.images.find((i) => i.id === id)
    if (!img || img.locked) return
    e.stopPropagation()
    capture(e)
    select({ images: [id] })
    setGesture({
      kind: 'image',
      id,
      grabOffset: sub(toWorld(e.clientX, e.clientY), { x: img.x, y: img.y }),
    })
  }

  // -- surface ------------------------------------------------------------

  const onSurfacePointerDown = (e: React.PointerEvent) => {
    const world = toWorld(e.clientX, e.clientY)
    const wantsPan = tool === 'pan' || e.button === 1

    if (wantsPan) {
      capture(e)
      setGesture({
        kind: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        startVp: { x: viewport.x, y: viewport.y },
      })
      return
    }
    if (e.button !== 0) return

    if (tool === 'station') {
      const id = addStation(world, space)
      select({ stations: [id] })
      return
    }

    if (tool === 'terrain') {
      const snapped = snapTerrain(world, draftNeighbours(draft)).point

      // Text is a single point, so it commits on the first click rather than waiting
      // for an Enter that would never come.
      if (terrainKind === 'label') {
        const id = addTerrain('label', [snapped], space, 'New text', false)
        select({ terrain: [id] })
        setTool('select')
        setDraftCursor(null)
        return
      }
      const closed =
        terrainKind === 'water' ||
        terrainKind === 'green' ||
        terrainKind === 'builtup' ||
        terrainKind === 'boundary'
      setDraft((d) =>
        d
          ? { ...d, points: [...d.points, snapped] }
          : { kind: terrainKind, points: [snapped], closed },
      )
      return
    }

    if (tool === 'select') {
      capture(e)
      setGesture({ kind: 'marquee', a: world, b: world, additive: e.shiftKey })
      if (!e.shiftKey) clearSelection()
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const world = toWorld(e.clientX, e.clientY)

    // Tracing has no gesture — the shape grows on clicks — so the preview and its
    // guides are driven straight off pointer movement.
    if (tool === 'terrain' && !gesture) {
      const r = snapTerrain(world, draftNeighbours(draft))
      setDraftCursor(r.point)
      setGuides(r.guides)
      return
    }

    if (!gesture) return

    switch (gesture.kind) {
      case 'pan':
        userMovedRef.current = true
        setViewport(space, {
          x: gesture.startVp.x + (e.clientX - gesture.startClient.x),
          y: gesture.startVp.y + (e.clientY - gesture.startClient.y),
        })
        return

      case 'marquee':
        setGesture({ ...gesture, b: world })
        return

      case 'terrainPoint': {
        const shape = project.terrain.find((t) => t.id === gesture.id)
        const pts = shape?.[space] ?? []
        const neighbours: Vec2[] = []
        const prev = pts[gesture.index - 1] ?? (shape?.closed ? pts[pts.length - 1] : undefined)
        const next = pts[gesture.index + 1] ?? (shape?.closed ? pts[0] : undefined)
        if (prev) neighbours.push(prev)
        if (next) neighbours.push(next)

        const r = snapTerrain(sub(world, gesture.grabOffset), neighbours, {
          id: gesture.id,
          index: gesture.index,
        })
        setGuides(r.guides)
        moveTerrainPoint(gesture.id, gesture.index, r.point, space, {
          coalesceKey: `terrain-pt-${gesture.id}-${gesture.index}-${space}`,
        })
        return
      }

      case 'placement': {
        // Furniture moves by cursor delta with no snapping: a legend or a north arrow
        // is positioned by eye against the whole composition, not against the grid.
        const delta = sub(world, gesture.last)
        movePlacements(gesture.ids, delta, space, {
          coalesceKey: `placement-${gesture.ids.join(',')}-${space}`,
        })
        setGesture({ ...gesture, last: world })
        return
      }

      case 'terrain': {
        // Snap the cursor rather than each vertex: the shape keeps its exact form and
        // still lands on the grid or in line with something.
        const moving = new Set(gesture.ids)
        const others = terrainOthers(world).filter(
          (q) =>
            !project.terrain.some(
              (t) => moving.has(t.id) && t[space].some((v) => dist(v, q) < 1e-6),
            ),
        )
        const snappedCursor = snapSuspended
          ? world
          : snapPoint({
              raw: world,
              neighbours: [],
              others,
              spacing: [],
              levels: levelsNear(world),
              settings: project.snap,
            }).point

        const delta = sub(snappedCursor, gesture.last)
        if (Math.abs(delta.x) < 1e-6 && Math.abs(delta.y) < 1e-6) return
        moveTerrain(gesture.ids, delta, space, {
          coalesceKey: `terrain-drag-${gesture.ids.join(',')}-${space}`,
        })
        setGesture({ ...gesture, last: snappedCursor })
        return
      }

      case 'image': {
        const img = project.images.find((i) => i.id === gesture.id)
        if (!img) return
        let x = world.x - gesture.grabOffset.x
        let y = world.y - gesture.grabOffset.y

        // Edge snapping against the other screenshots — this is the grid-assist that
        // makes manual stitching quick: nudge a tile near its neighbour and it clicks in.
        for (const other of project.images) {
          if (other.id === img.id || other.hidden) continue
          for (const [candidate, target] of [
            [x, other.x + other.width],
            [x, other.x],
            [x + img.width, other.x],
            [x + img.width, other.x + other.width],
          ] as [number, number][]) {
            if (Math.abs(candidate - target) < IMAGE_SNAP) x += target - candidate
          }
          for (const [candidate, target] of [
            [y, other.y + other.height],
            [y, other.y],
            [y + img.height, other.y],
            [y + img.height, other.y + other.height],
          ] as [number, number][]) {
            if (Math.abs(candidate - target) < IMAGE_SNAP) y += target - candidate
          }
        }

        updateImage(
          gesture.id,
          { x: Math.round(x), y: Math.round(y) },
          { coalesceKey: `img-${gesture.id}` },
        )
        return
      }

      case 'bend': {
        const [a, b] = gesture.key.split('|') as [StationId, StationId]
        const raw = sub(world, gesture.grabOffset)

        // A bend gets the same treatment as a station. This is what makes the
        // "runs past without stopping" position reachable: drag a corner onto the
        // level just outside a bundle and the route slides alongside it.
        let target = raw
        let nextGuides: GuideLine[] = []
        if (!snapSuspended) {
          const ends = [a, b]
            .map((id) => project.stations.find((s) => s.id === id)?.[space])
            .filter((p): p is Vec2 => !!p)
          const result = snapPoint({
            raw,
            neighbours: ends,
            others: project.stations.map((s) => s[space]),
            spacing: [],
            levels: levelsNear(raw),
            settings: project.snap,
          })
          target = result.point
          nextGuides = result.guides
        }
        setGuides(nextGuides)

        moveBend(gesture.lineId, a, b, gesture.index, target, space, {
          coalesceKey: `bend-${gesture.lineId}-${gesture.key}-${gesture.index}`,
        })
        return
      }

      case 'label': {
        const delta = sub(world, gesture.startWorld)
        setLabel(gesture.id, {
          offset: {
            x: gesture.startOffset.x + delta.x,
            y: gesture.startOffset.y + delta.y,
          },
          // Dragging a label is how you take it off auto-placement.
          pinned: true,
          anchor:
            project.stations.find((s) => s.id === gesture.id)?.label.anchor === 'auto'
              ? (labelAnchors.get(gesture.id) ?? 'e')
              : undefined,
        })
        return
      }

      case 'stations': {
        const raw = sub(world, gesture.grabOffset)
        const primary = project.stations.find((s) => s.id === gesture.primary)
        if (!primary) return

        let target = raw
        let nextGuides: GuideLine[] = []

        if (!snapSuspended && gesture.ids.length === 1) {
          const moving = new Set(gesture.ids)
          const posOf = (id: StationId) =>
            project.stations.find((s) => s.id === id)?.[space]
          const neighbourIds = [...(network.neighbours.get(gesture.primary) ?? [])]

          const result = snapPoint({
            raw,
            movingId: gesture.primary,
            neighbours: neighbourIds.map(posOf).filter((p): p is Vec2 => !!p),
            others: project.stations.filter((s) => !moving.has(s.id)).map((s) => s[space]),
            spacing: spacingRefsFor(
              primary[space],
              neighbourIds.map((nid) => ({
                pos: posOf(nid) ?? { x: 0, y: 0 },
                theirNeighbours: [...(network.neighbours.get(nid) ?? [])]
                  .map(posOf)
                  .filter((p): p is Vec2 => !!p),
              })),
            ),
            levels: levelsNear(raw, gesture.primary),
            settings: project.snap,
          })
          target = result.point
          nextGuides = result.guides
        }

        setGuides(nextGuides)
        const delta = sub(target, primary[space])
        if (Math.abs(delta.x) < 1e-6 && Math.abs(delta.y) < 1e-6) return

        mutate(
          gesture.ids.length > 1 ? 'Move stations' : 'Move station',
          (d) => {
            for (const id of gesture.ids) {
              const s = d.stations.find((x) => x.id === id)
              if (s) s[space] = { x: s[space].x + delta.x, y: s[space].y + delta.y }
            }
          },
          { coalesceKey: `drag-${gesture.ids.join(',')}-${space}` },
        )
        return
      }
    }
  }

  const endGesture = () => {
    if (gesture?.kind === 'marquee') {
      const { a, b, additive } = gesture
      const minX = Math.min(a.x, b.x)
      const maxX = Math.max(a.x, b.x)
      const minY = Math.min(a.y, b.y)
      const maxY = Math.max(a.y, b.y)
      // A click without a drag should clear, not select everything.
      if (Math.abs(maxX - minX) > 3 || Math.abs(maxY - minY) > 3) {
        if (cropping && space === 'geo') {
          // The same drag, read differently: cut the region out of the screenshots
          // rather than selecting what is inside it.
          void (async () => {
            const asset = await cropAssetFromImages(
              project.images,
              { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
              `Crop ${project.assets.length + 1}`,
            )
            if (asset) addAsset(asset)
            setCropping(false)
          })()
          setGesture(null)
          setGuides([])
          return
        }
        const hits = project.stations
          .filter((s) => {
            const p = s[space]
            return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
          })
          .map((s) => s.id)
        select({ stations: hits }, additive)
      }
    }
    setGesture(null)
    setGuides([])
  }

  const cursor =
    tool === 'pan'
      ? gesture?.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : cropping || tool === 'station' || tool === 'terrain'
        ? 'crosshair'
        : 'default'

  const viewBounds = {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    w: size.w / viewport.zoom,
    h: size.h / viewport.zoom,
  }

  return (
    <svg
      ref={svgRef}
      data-map-surface="true"
      className="flex-1 touch-none select-none"
      style={{ background: project.style.background, cursor }}
      onPointerDown={onSurfacePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onDoubleClick={() => draft && commitDraft()}
    >
      <TerrainPatterns />
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        <GridLayer project={project} space={space} zoom={viewport.zoom} bounds={viewBounds} />

        {space === 'geo' && project.view.showScreenshots && (
          <ScreenshotLayer
            project={project}
            selected={selectedImages}
            onPointerDown={onImagePointerDown}
          />
        )}

        {project.view.showTerrain && (
          <TerrainLayer
            project={project}
            space={space}
            selected={selectedTerrain}
            onPointerDown={onTerrainPointerDown}
          />
        )}

        <TerrainHandlesLayer
          project={project}
          space={space}
          selected={selectedTerrain}
          zoom={viewport.zoom}
          onPointPointerDown={onTerrainPointPointerDown}
          onEdgePointerDown={onTerrainEdgePointerDown}
        />

        <GhostLayer project={project} space={space} />

        <LinesLayer
          project={project}
          network={network}
          space={space}
          selectedLines={selectedLines}
          selectedCrossings={selectedCrossingSet}
          zoom={viewport.zoom}
          onLinePointerDown={onLinePointerDown}
          onSegmentPointerDown={onSegmentPointerDown}
          onCrossingPointerDown={onCrossingPointerDown}
        />

        <TransferLayer
          project={project}
          space={space}
          selected={selectedTransfers}
          onPointerDown={onTransferPointerDown}
        />

        {route && <RouteLayer project={project} space={space} path={route.path} />}

        <BendHandlesLayer
          project={project}
          space={space}
          selectedLines={selectedLines}
          zoom={viewport.zoom}
          onBendPointerDown={onBendPointerDown}
        />

        <StationsLayer
          project={project}
          network={network}
          space={space}
          selected={selectedStations}
          onPointerDown={onStationPointerDown}
        />

        <LabelsLayer
          project={project}
          network={network}
          space={space}
          onPointerDown={onLabelPointerDown}
        />

        <BadgeLayer project={project} network={network} space={space} />

        <PlacementLayer
          project={project}
          space={space}
          selected={selectedPlacements}
          onPointerDown={onPlacementPointerDown}
        />

        <GuidesLayer guides={guides} zoom={viewport.zoom} />

        <DraftLayer
          points={draft?.points ?? []}
          closed={draft?.closed ?? false}
          marquee={gesture?.kind === 'marquee' ? { a: gesture.a, b: gesture.b } : null}
          cursor={tool === 'terrain' ? draftCursor : null}
          zoom={viewport.zoom}
        />
      </g>
    </svg>
  )
}

/** Ask the surface to fit content or the current selection. */
export const requestFit = (target: 'all' | 'selection' = 'all') =>
  window.dispatchEvent(new CustomEvent('tds:fit', { detail: target }))

export { segmentKey, dist }
