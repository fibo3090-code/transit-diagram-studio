import { newProjectId } from './ids'
import type {
  Branch,
  BranchId,
  ModeStyle,
  Project,
  SnapSettings,
  Station,
  StationId,
  StyleSettings,
  Terrain,
  TerrainId,
  TerrainKind,
  Vec2,
  ViewSettings,
} from './types'
import { PROJECT_VERSION } from './types'

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export const DEFAULT_MODES: ModeStyle[] = [
  { id: 'metro', name: 'Metro', color: '#C9342B', strokeWidth: 8, stationSymbol: 'circle', z: 40 },
  { id: 'rail', name: 'Rail', color: '#1B4F9C', strokeWidth: 9, stationSymbol: 'square', z: 50 },
  { id: 'tram', name: 'Tram', color: '#00784F', strokeWidth: 5, stationSymbol: 'circle', z: 30 },
  { id: 'bus', name: 'Bus', color: '#B45A0E', strokeWidth: 4, dash: [10, 6], stationSymbol: 'circle', z: 20 },
  { id: 'ferry', name: 'Ferry', color: '#0D7C93', strokeWidth: 4, dash: [2, 8], stationSymbol: 'anchor', z: 10 },
  { id: 'cable', name: 'Cable', color: '#6B4796', strokeWidth: 4, dash: [1, 7], stationSymbol: 'diamond', z: 15 },
]

export const modeById = (modes: ModeStyle[], id: string): ModeStyle =>
  modes.find((m) => m.id === id) ?? modes[0] ?? DEFAULT_MODES[0]

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------

/** Curated so any two entries stay distinguishable side by side on a corridor. */
export const LINE_PALETTE: string[] = [
  '#C9342B', // red
  '#1B4F9C', // blue
  '#00784F', // green
  '#B45A0E', // orange
  '#6B4796', // violet
  '#0D7C93', // teal
  '#A8143C', // crimson
  '#4B6A16', // olive
  '#8C4A00', // brown
  '#00639B', // cerulean
  '#B3187C', // magenta
  '#5C5F66', // grey
  '#D4A017', // ochre
  '#2E7D6B', // sea green
  '#7A2E8E', // purple
  '#12557A', // steel
]

/** Relative luminance per WCAG, used for the contrast check in the validator. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Rough perceptual distance, good enough to flag two lines that look alike. */
export function colorDistance(a: string, b: string): number {
  const parse = (hex: string) => {
    const h = hex.replace('#', '')
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  }
  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  const rm = (r1 + r2) / 2
  // Weighted RGB distance; cheap and matches perception better than plain euclidean.
  return Math.sqrt(
    (2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2,
  )
}

/** First palette colour not already in use, falling back to the least-similar one. */
export function nextUnusedColor(used: string[]): string {
  const lower = used.map((c) => c.toLowerCase())
  const free = LINE_PALETTE.find((c) => !lower.includes(c.toLowerCase()))
  if (free) return free
  let best = LINE_PALETTE[0]
  let bestScore = -1
  for (const c of LINE_PALETTE) {
    const score = Math.min(...used.map((u) => colorDistance(c, u)))
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Style presets
// ---------------------------------------------------------------------------

export interface StylePreset {
  id: string
  name: string
  description: string
  style: Omit<StyleSettings, 'presetId'>
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'london',
    name: 'London',
    description: 'Rounded corners, generous spacing, classic round stops.',
    style: {
      corridorSpacing: 11,
      strokeScale: 1,
      stationRadius: 6,
      casingLength: 3,
      casingHeight: 3,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 13,
      background: '#FFFFFF',
      foreground: '#111827',
      cornerRadius: 14,
      badgeShape: 'roundel',
      secondaryNameScale: 0.78,
      hitRadius: 14,
    },
  },
  {
    id: 'tokyo-dense',
    name: 'Tokyo dense',
    description: 'Thin strokes, tight spacing, small type for busy networks.',
    style: {
      corridorSpacing: 7,
      strokeScale: 0.72,
      stationRadius: 4.5,
      casingLength: 2,
      casingHeight: 2,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 10.5,
      background: '#FFFFFF',
      foreground: '#1A1A1A',
      cornerRadius: 6,
      badgeShape: 'circle',
      secondaryNameScale: 0.74,
      hitRadius: 11,
    },
  },
  {
    id: 'high-contrast',
    name: 'High contrast',
    description: 'Heavy strokes on near-black, for screens and projection.',
    style: {
      corridorSpacing: 13,
      strokeScale: 1.25,
      stationRadius: 7,
      casingLength: 3.5,
      casingHeight: 3.5,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 14,
      background: '#0B0F14',
      foreground: '#F2F5F9',
      cornerRadius: 10,
      badgeShape: 'circle',
      secondaryNameScale: 0.80,
      hitRadius: 16,
    },
  },
  {
    id: 'print-safe',
    name: 'Print safe',
    description: 'Mitred corners and larger type, tuned for paper.',
    style: {
      corridorSpacing: 12,
      strokeScale: 1.1,
      stationRadius: 6.5,
      casingLength: 3,
      casingHeight: 3,
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: 14,
      background: '#FFFFFF',
      foreground: '#000000',
      cornerRadius: 0,
      badgeShape: 'roundel',
      secondaryNameScale: 0.78,
      hitRadius: 15,
    },
  },
]

export const presetById = (id: string): StylePreset =>
  STYLE_PRESETS.find((p) => p.id === id) ?? STYLE_PRESETS[0]

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SNAP: SnapSettings = {
  angle: true,
  grid: true,
  align: true,
  spacing: true,
  levels: true,
  gridSize: 20,
  tolerance: 12,
}

export const DEFAULT_VIEW: ViewSettings = {
  showGeoGhosts: false,
  showTerrain: true,
  showLabels: true,
  showScreenshots: true,
  screenshotOpacity: 1,
  showGrid: true,
  autoLabels: true,
  showLineBadges: true,
  showZones: true,
  showBadges: true,
  showPlacements: true,
  showDirection: true,
}

export function defaultStyle(presetId = 'london'): StyleSettings {
  const p = presetById(presetId)
  return { presetId: p.id, ...p.style }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
//
// Every station, branch and terrain shape is built here and nowhere else. Before these
// existed each call site spelled out its own literal, so adding a field meant finding
// all of them -- and any one that was missed produced an object that type-checked at
// the boundary but was missing a value the renderer expected.

export function makeStation(
  id: StationId,
  name: string,
  at: Vec2,
  extra: Partial<Station> = {},
): Station {
  return {
    id,
    name,
    geo: { ...at },
    schematic: { ...at },
    modes: [],
    label: { anchor: 'auto', offset: { x: 0, y: 0 }, pinned: false, angle: 0, hidden: false },
    badges: [],
    status: 'open',
    symbol: { kind: 'auto' },
    ...extra,
  }
}

export function makeBranch(id: BranchId, stops: StationId[] = [], extra: Partial<Branch> = {}): Branch {
  return { id, stops, passes: [], direction: 'both', ...extra }
}

export function makeTerrain(
  id: TerrainId,
  kind: TerrainKind,
  extra: Partial<Terrain> = {},
): Terrain {
  return {
    id,
    kind,
    name: '',
    geo: [],
    schematic: [],
    closed: false,
    hidden: false,
    holes: [],
    fill: 'solid',
    ...extra,
  }
}

export function createEmptyProject(name = 'Untitled network'): Project {
  const now = Date.now()
  return {
    id: newProjectId(),
    version: PROJECT_VERSION,
    name,
    createdAt: now,
    updatedAt: now,
    images: [],
    terrain: [],
    stations: [],
    lines: [],
    transfers: [],
    assets: [],
    placements: [],
    corridorOrder: {},
    crossings: {},
    modes: DEFAULT_MODES.map((m) => ({ ...m })),
    snap: { ...DEFAULT_SNAP },
    style: defaultStyle(),
    view: { ...DEFAULT_VIEW },
  }
}
