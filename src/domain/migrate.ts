/**
 * Bringing a stored project up to date.
 *
 * Projects are saved to IndexedDB and to files, so any project can outlive the version
 * of the app that wrote it. Whenever a new setting is added, every previously saved
 * project is missing it — which, for a boolean, silently reads as `false` and quietly
 * turns the feature off for existing work.
 *
 * Everything loaded from anywhere goes through `normalizeProject` so that cannot happen.
 * It fills gaps with defaults and never overwrites a value that is already present.
 */

import {
  DEFAULT_MODES,
  DEFAULT_SNAP,
  DEFAULT_VIEW,
  defaultStyle,
} from './defaults'
import { newBranchId } from './ids'
import type { ModeStyle, Project, Station, Terrain, Transfer, Vec2 } from './types'
import { PROJECT_VERSION } from './types'

const vec = (v: Partial<Vec2> | undefined, fallback: Vec2): Vec2 => ({
  x: typeof v?.x === 'number' && Number.isFinite(v.x) ? v.x : fallback.x,
  y: typeof v?.y === 'number' && Number.isFinite(v.y) ? v.y : fallback.y,
})

export function normalizeProject(raw: Project): Project {
  const p = raw as Partial<Project> & Project

  const style = { ...defaultStyle(p.style?.presetId ?? 'london'), ...(p.style ?? {}) }

  // Casing used to be a single width driving both axes. Carry it across to whichever
  // of the two new sliders is missing, so an older project keeps the look it had.
  const legacyCasing = (p.style as unknown as { casingWidth?: number } | undefined)?.casingWidth
  if (typeof legacyCasing === 'number') {
    if (p.style?.casingLength === undefined) style.casingLength = legacyCasing
    if (p.style?.casingHeight === undefined) style.casingHeight = legacyCasing
  }
  const snap = { ...DEFAULT_SNAP, ...(p.snap ?? {}) }
  const view = { ...DEFAULT_VIEW, ...(p.view ?? {}) }

  // A mode a line refers to must exist, or that line loses its stroke style entirely.
  //
  // v1 stored a per-project copy of the built-in modes, so a change to a built-in's
  // look could not reach existing projects. That was patched by refreshing the built-ins
  // on every load — which is no longer safe now that modes are editable, because it
  // would flatten your edits. So the refresh runs ONCE, as a real v1 -> v2 migration,
  // and after that the project's own mode list is authoritative.
  const stored = p.modes?.length ? [...p.modes] : []
  const builtinIds = new Set(DEFAULT_MODES.map((m) => m.id))
  const fromV1 = (p.version ?? 1) < 2

  let modes: ModeStyle[]
  if (fromV1) {
    modes = [
      ...DEFAULT_MODES.map((d) => {
        const was = stored.find((m) => m.id === d.id)
        // Colour was always per-project; the rest resets to the current default.
        return was ? { ...d, color: was.color } : { ...d }
      }),
      ...stored.filter((m) => !builtinIds.has(m.id)),
    ]
  } else {
    // Keep whatever the project says, but never leave the list empty.
    modes = stored.length ? stored.map((m) => ({ ...m })) : DEFAULT_MODES.map((m) => ({ ...m }))
  }
  const modeIds = new Set(modes.map((m) => m.id))

  const stations: Station[] = (p.stations ?? []).map((s) => {
    const geo = vec(s.geo, { x: 0, y: 0 })
    return {
      ...s,
      geo,
      // A project written before the two-space model would only have one position.
      schematic: vec(s.schematic, geo),
      modes: s.modes ?? [],
      label: {
        anchor: s.label?.anchor ?? 'auto',
        offset: vec(s.label?.offset, { x: 0, y: 0 }),
        pinned: s.label?.pinned ?? false,
        angle: s.label?.angle ?? 0,
        hidden: s.label?.hidden ?? false,
      },
      // v2 -> v3. Absent is not the same as empty for `symbol`: a missing value has to
      // mean "derive it from the graph", which is what every v2 project did.
      badges: s.badges ?? [],
      status: s.status ?? 'open',
      symbol: s.symbol ?? { kind: 'auto' },
    }
  })

  const lines = (p.lines ?? []).map((l) => {
    const branches = l.branches?.length
      ? l.branches.map((b) => ({
          ...b,
          stops: b.stops ?? [],
          // v2 -> v3. Every existing branch called at every station it listed and could
          // be ridden both ways, so these are the values that preserve behaviour.
          passes: b.passes ?? [],
          direction: b.direction ?? ('both' as const),
        }))
      : [{ id: newBranchId(), stops: [], passes: [], direction: 'both' as const }]

    const bends: Project['lines'][number]['bends'] = {}
    for (const [key, list] of Object.entries(l.bends ?? {})) {
      bends[key] = (list ?? []).map((bend) => {
        // Bends used to be a bare point; give the missing space the same position so a
        // route keeps the shape it had rather than snapping to a straight line.
        const anyBend = bend as unknown as Partial<Vec2> & Partial<{ geo: Vec2; schematic: Vec2 }>
        const geo = anyBend.geo ?? vec(anyBend, { x: 0, y: 0 })
        return { geo, schematic: anyBend.schematic ?? geo }
      })
    }

    return {
      ...l,
      mode: modeIds.has(l.mode) ? l.mode : (modes[0]?.id ?? 'metro'),
      branches,
      bends,
      hidden: l.hidden ?? false,
    }
  })

  const terrain: Terrain[] = (p.terrain ?? []).map((t) => {
    const geo = t.geo ?? []
    return {
      ...t,
      geo,
      schematic: t.schematic?.length ? t.schematic : geo.map((q) => ({ ...q })),
      name: t.name ?? '',
      closed: t.closed ?? false,
      hidden: t.hidden ?? false,
      // v2 -> v3. `solid` is how every kind was painted before fills existed.
      holes: (t.holes ?? []).map((h) => ({
        geo: h.geo ?? [],
        schematic: h.schematic?.length ? h.schematic : (h.geo ?? []).map((q) => ({ ...q })),
      })),
      fill: t.fill ?? 'solid',
    }
  })

  const images = (p.images ?? []).map((i) => ({
    ...i,
    x: i.x ?? 0,
    y: i.y ?? 0,
    opacity: typeof i.opacity === 'number' ? i.opacity : 1,
    locked: i.locked ?? false,
    hidden: i.hidden ?? false,
    placedBy: i.placedBy ?? 'manual',
  }))

  // Same reasoning as placements: a symbol referencing a deleted asset would render
  // nothing at all, so fall back to the derived mark rather than losing the station.
  const assetIdsForSymbols = new Set((p.assets ?? []).map((a) => a.id))
  for (const s of stations) {
    if (s.symbol.kind === 'asset' && !assetIdsForSymbols.has(s.symbol.assetId)) {
      s.symbol = { kind: 'auto' }
    }
  }

  const known = new Set(stations.map((s) => s.id))
  // A link to a station that no longer exists would draw a stroke into nowhere.
  const transfers: Transfer[] = (p.transfers ?? []).filter(
    (t) => known.has(t.a) && known.has(t.b) && t.a !== t.b,
  ).map((t) => ({ ...t, note: t.note ?? '', hidden: t.hidden ?? false }))

  const assets = (p.assets ?? []).map((a) => ({ ...a, source: a.source ?? 'import' }))
  const assetIds = new Set(assets.map((a) => a.id))
  // A placement whose asset is gone would draw nothing and be unselectable -- an
  // invisible object you cannot delete. Drop it, as transfers to dead stations are.
  const placements = (p.placements ?? [])
    .filter((pl) => pl.what?.kind !== 'asset' || assetIds.has(pl.what.assetId))
    .map((pl) => ({
      ...pl,
      geo: vec(pl.geo, { x: 0, y: 0 }),
      schematic: vec(pl.schematic, vec(pl.geo, { x: 0, y: 0 })),
      scale: typeof pl.scale === 'number' ? pl.scale : 1,
      angle: pl.angle ?? 0,
      opacity: typeof pl.opacity === 'number' ? pl.opacity : 1,
      locked: pl.locked ?? false,
      hidden: pl.hidden ?? false,
    }))

  return {
    ...p,
    version: PROJECT_VERSION,
    assets,
    placements,
    transfers,
    name: p.name ?? 'Untitled network',
    createdAt: p.createdAt ?? Date.now(),
    updatedAt: p.updatedAt ?? Date.now(),
    stations,
    lines,
    terrain,
    images,
    corridorOrder: p.corridorOrder ?? {},
    crossings: p.crossings ?? {},
    modes,
    snap,
    style,
    view,
  }
}
