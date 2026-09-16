/**
 * Core data model.
 *
 * The governing idea: ONE network, TWO positions. Every station and terrain shape
 * carries both its true position on the stitched screenshot (`geo`) and the position
 * you dragged it to on the diagram (`schematic`). Lines, interchanges and corridors
 * are the same objects in both views, so recomposing the diagram can never break the
 * network.
 *
 * The second rule: interchanges, corridors, parallel offsets and terminus caps are
 * NEVER stored. They are derived from `stops` at render time (see `network.ts`), so
 * they cannot drift out of sync with the graph.
 */

export type Vec2 = { x: number; y: number }

export type StationId = string & { readonly __brand: 'StationId' }
export type LineId = string & { readonly __brand: 'LineId' }
export type BranchId = string & { readonly __brand: 'BranchId' }
export type TerrainId = string & { readonly __brand: 'TerrainId' }
export type ImageId = string & { readonly __brand: 'ImageId' }
export type TransferId = string & { readonly __brand: 'TransferId' }
export type ProjectId = string & { readonly __brand: 'ProjectId' }

/**
 * Canonical key for an undirected segment between two stations, always
 * `${min}|${max}` so that a line running A->B and another running B->A resolve to the
 * same corridor. Built by `segmentKey()`; never assemble one by hand.
 */
export type SegmentKey = string & { readonly __brand: 'SegmentKey' }

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type ModeId = string

export type StationSymbol = 'tick' | 'circle' | 'square' | 'diamond' | 'anchor'

export interface ModeStyle {
  id: ModeId
  name: string
  /** Default colour offered when creating a line of this mode. */
  color: string
  strokeWidth: number
  /** SVG dash pattern in diagram units; undefined means solid. */
  dash?: number[]
  stationSymbol: StationSymbol
  /** Draw order; lower renders first (underneath). */
  z: number
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export type LabelAnchor = 'auto' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export interface StationLabel {
  /** `auto` means the placement engine owns it. Dragging sets a concrete anchor. */
  anchor: LabelAnchor
  /** Manual nudge applied after anchoring. */
  offset: Vec2
  /** True once you have moved it by hand; auto-placement then leaves it alone. */
  pinned: boolean
  /** Degrees; 0 is horizontal. */
  angle: number
  hidden: boolean
}

export interface Station {
  id: StationId
  name: string
  /** Pixel position on the stitched canvas. Set in the geographic view. */
  geo: Vec2
  /** Pixel position on the diagram. Set in the schematic view. */
  schematic: Vec2
  /** Modes served here. Used for symbol choice when no line is more specific. */
  modes: ModeId[]
  label: StationLabel
  notes?: string
}

// ---------------------------------------------------------------------------
// Lines and branches
// ---------------------------------------------------------------------------

/**
 * A branch is one continuous run of stops. A line with a single branch is an ordinary
 * line; a line with several is a Y-shaped or multi-tailed service. Branches of the same
 * line share an identity (name, mode, colour) and normally share stations where they
 * join — the junction station simply appears in more than one branch.
 */
export interface Branch {
  id: BranchId
  /** Optional qualifier shown in the UI, e.g. "via Docks" or "to Airport". */
  name?: string
  stops: StationId[]
}

/**
 * A manual bend point on a segment. It carries both positions for the same reason a
 * station does: a corner you added to dodge a river in the geographic view should not
 * distort the diagram, and a corner you added to square off the diagram should not
 * move the geographic route.
 */
export interface Bend {
  geo: Vec2
  schematic: Vec2
}

export interface Line {
  id: LineId
  name: string
  mode: ModeId
  color: string
  branches: Branch[]
  /**
   * Manual geometry overrides, keyed by canonical segment key. Points are stored in
   * canonical order (from the lower station id to the higher); a traversal in the other
   * direction reverses them. Absent means the segment is auto-routed straight.
   */
  bends: Record<string, Bend[]>
  hidden: boolean
}

// ---------------------------------------------------------------------------
// Out-of-station interchanges
// ---------------------------------------------------------------------------

/**
 * A walking link between two SEPARATE stations.
 *
 * Not every interchange is one place. Plenty of real networks ask you to leave one
 * station and walk to another, and a map has to say so — which is impossible if the
 * only way to express an interchange is "several lines call at the same station".
 */
export interface Transfer {
  id: TransferId
  a: StationId
  b: StationId
  /** Shown alongside the link, e.g. "5 min walk". */
  note: string
  hidden: boolean
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export type TerrainKind =
  | 'water'      // filled body: lake, sea
  | 'waterway'   // stroked: river, canal
  | 'green'      // park, forest
  | 'builtup'    // urban area wash
  | 'boundary'   // district / city outline
  | 'label'      // free-standing text, positioned by its first point

export interface Terrain {
  id: TerrainId
  kind: TerrainKind
  name: string
  /** Traced over the screenshot. */
  geo: Vec2[]
  /** Simplified for the diagram. Starts as a copy of `geo`. */
  schematic: Vec2[]
  closed: boolean
  hidden: boolean
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageLayer {
  id: ImageId
  name: string
  /** Key into the IndexedDB blob store; the bytes never live in the project JSON. */
  blobKey: string
  /** Natural pixel dimensions after any downscale-on-import. */
  width: number
  height: number
  /** Top-left position on the stitched canvas. */
  x: number
  y: number
  opacity: number
  locked: boolean
  hidden: boolean
  placedBy: 'manual' | 'auto'
  /** 0..1, only meaningful when placedBy === 'auto'. */
  confidence?: number
}

// ---------------------------------------------------------------------------
// View + style settings
// ---------------------------------------------------------------------------

export type SnapKind = 'angle' | 'grid' | 'align' | 'spacing' | 'levels'

export interface SnapSettings {
  angle: boolean
  grid: boolean
  align: boolean
  spacing: boolean
  /**
   * Snap to the individual parallel tracks running through a multi-line stop, and to
   * the track just outside the bundle — the position that reads as "passes through
   * without stopping".
   */
  levels: boolean
  /** Grid pitch in diagram units. */
  gridSize: number
  /** Snap radius in diagram units; a candidate must land within this to win. */
  tolerance: number
}

export interface StyleSettings {
  presetId: string
  /** Centre-to-centre distance between parallel lines in a shared corridor. */
  corridorSpacing: number
  /** Multiplier applied to every mode's stroke width. */
  strokeScale: number
  stationRadius: number
  /**
   * Extra clearance ALONG the upper line at a crossing — how far past the line
   * underneath the break extends. The width of the line underneath is covered
   * automatically; this is the margin on top of it. 0 turns crossings off.
   */
  casingLength: number
  /**
   * Clearance ACROSS the upper line at a crossing — how far the break reaches beyond
   * the upper line's own edges.
   */
  casingHeight: number
  fontFamily: string
  fontSize: number
  background: string
  foreground: string
  /** Corner rounding on line bends, in diagram units. 0 is mitred. */
  cornerRadius: number
}

export interface ViewSettings {
  showGeoGhosts: boolean
  showTerrain: boolean
  showLabels: boolean
  showScreenshots: boolean
  screenshotOpacity: number
  /** Dot grid in the schematic view, so the snap pitch is visible while composing. */
  showGrid: boolean
  /** Let the placement engine choose label positions; pinned labels are exempt. */
  autoLabels: boolean
  /** Route bullets at each end of every line. */
  showLineBadges: boolean
}

/**
 * Per-crossing tuning.
 *
 * Keyed by `crossingKey()`, which identifies a crossing by the two stop-pairs that
 * produce it rather than by where it happens to land — so an override survives moving
 * the stations around, and is correctly forgotten if you rewire the lines.
 */
export interface CrossingOverride {
  /** Replaces `style.casingLength` here. */
  length?: number
  /** Replaces `style.casingHeight` here. */
  height?: number
  /** Send the other line over the top instead. */
  flip?: boolean
  /** Draw no break at all at this crossing. */
  off?: boolean
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const PROJECT_VERSION = 2 as const

export interface Project {
  id: ProjectId
  version: typeof PROJECT_VERSION
  name: string
  createdAt: number
  updatedAt: number

  images: ImageLayer[]
  terrain: Terrain[]
  stations: Station[]
  lines: Line[]
  transfers: Transfer[]

  /**
   * Per-corridor override of which line sits on which side. Absent means the default
   * ordering (project line order) applies, which keeps offsets consistent across
   * consecutive shared segments without any bookkeeping.
   */
  corridorOrder: Record<string, LineId[]>

  /** Per-crossing tuning; absent entries follow the style defaults. */
  crossings: Record<string, CrossingOverride>

  modes: ModeStyle[]
  snap: SnapSettings
  style: StyleSettings
  view: ViewSettings
}

/** What a saved `.tds.json` file contains. */
export interface ProjectFile {
  format: 'transit-diagram-studio'
  version: typeof PROJECT_VERSION
  project: Project
  /** Present only in the self-contained variant. Maps blobKey -> data URL. */
  images?: Record<string, string>
}
