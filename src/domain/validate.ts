import { colorDistance } from './defaults'
import { dist } from './geometry'
import { buildNetwork, lineStopCount, type Network } from './network'
import { findOverlaps } from './overlaps'
import type { LineId, Project, StationId } from './types'

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface Issue {
  id: string
  severity: IssueSeverity
  title: string
  detail: string
  stationIds?: StationId[]
  lineIds?: LineId[]
}

/** Below this, two line colours are hard to tell apart on adjacent strokes. */
const COLOR_MIN_DISTANCE = 90

/** Below this (in diagram units), two stations are effectively stacked. */
const COINCIDENT_DISTANCE = 2

export function validateProject(project: Project, network?: Network): Issue[] {
  const net = network ?? buildNetwork(project)
  const issues: Issue[] = []
  const stationNames = new Map<string, StationId[]>()
  const known = new Set(project.stations.map((s) => s.id))

  // --- stations ---------------------------------------------------------

  for (const s of project.stations) {
    const key = s.name.trim().toLowerCase()
    if (key.length === 0) {
      issues.push({
        id: `unnamed-${s.id}`,
        severity: 'warning',
        title: 'Unnamed station',
        detail: 'A station has no name, so it will export without a label.',
        stationIds: [s.id],
      })
      continue
    }
    const list = stationNames.get(key) ?? []
    list.push(s.id)
    stationNames.set(key, list)
  }

  for (const [name, ids] of stationNames) {
    if (ids.length > 1) {
      issues.push({
        id: `dupe-name-${name}`,
        severity: 'warning',
        title: `${ids.length} stations named the same`,
        detail: `"${name}" is used ${ids.length} times. Interchanges should be one station served by several lines, not several stations sharing a name.`,
        stationIds: ids,
      })
    }
  }

  if (net.orphans.size > 0) {
    issues.push({
      id: 'orphans',
      severity: 'info',
      title: `${net.orphans.size} station${net.orphans.size === 1 ? '' : 's'} on no line`,
      detail: 'These will render as isolated dots. Add them to a line or delete them.',
      stationIds: [...net.orphans],
    })
  }

  // Stacked stations, checked in the space you actually compose in.
  for (let i = 0; i < project.stations.length; i++) {
    for (let j = i + 1; j < project.stations.length; j++) {
      const a = project.stations[i]
      const b = project.stations[j]
      if (dist(a.schematic, b.schematic) < COINCIDENT_DISTANCE) {
        issues.push({
          id: `coincident-${a.id}-${b.id}`,
          severity: 'warning',
          title: 'Two stations in the same place',
          detail: `"${a.name}" and "${b.name}" sit on top of each other in the diagram.`,
          stationIds: [a.id, b.id],
        })
      }
    }
  }

  // --- lines ------------------------------------------------------------

  for (const line of project.lines) {
    if (line.name.trim().length === 0) {
      issues.push({
        id: `line-unnamed-${line.id}`,
        severity: 'warning',
        title: 'Unnamed line',
        detail: 'This line has no name, so it cannot appear in a legend.',
        lineIds: [line.id],
      })
    }

    if (lineStopCount(line) < 2) {
      issues.push({
        id: `line-short-${line.id}`,
        severity: 'error',
        title: `"${line.name || 'Untitled line'}" has fewer than two stops`,
        detail: 'A line needs at least two stops before anything can be drawn for it.',
        lineIds: [line.id],
      })
    }

    for (const branch of line.branches) {
      const missing = branch.stops.filter((id) => !known.has(id))
      if (missing.length > 0) {
        issues.push({
          id: `line-missing-${line.id}-${branch.id}`,
          severity: 'error',
          title: `"${line.name || 'Untitled line'}" references deleted stations`,
          detail: `${missing.length} stop${missing.length === 1 ? '' : 's'} on this branch no longer exist and are skipped when drawing.`,
          lineIds: [line.id],
        })
      }
      if (branch.stops.length === 1) {
        issues.push({
          id: `branch-single-${branch.id}`,
          severity: 'warning',
          title: `A branch of "${line.name || 'Untitled line'}" has one stop`,
          detail: 'Single-stop branches draw nothing. Add a stop or remove the branch.',
          lineIds: [line.id],
        })
      }
    }
  }

  // --- walking links -----------------------------------------------------

  for (const t of project.transfers) {
    const a = project.stations.find((s) => s.id === t.a)
    const b = project.stations.find((s) => s.id === t.b)
    if (!a || !b) continue
    const sameLine = (net.linesAtStation.get(t.a) ?? []).some((id) =>
      (net.linesAtStation.get(t.b) ?? []).includes(id),
    )
    if (sameLine) {
      issues.push({
        id: `transfer-redundant-${t.id}`,
        severity: 'info',
        title: `"${a.name}" and "${b.name}" are already on a common line`,
        detail: 'A walking link between them will rarely be the quickest way across.',
        stationIds: [t.a, t.b],
      })
    }
    if (dist(a.schematic, b.schematic) > 400) {
      issues.push({
        id: `transfer-far-${t.id}`,
        severity: 'warning',
        title: `The walk between "${a.name}" and "${b.name}" is drawn very long`,
        detail: 'On the diagram these sit far apart, which reads as a longer walk than an interchange usually is.',
        stationIds: [t.a, t.b],
      })
    }
  }

  // --- lines running through stations they do not serve -----------------

  // A line drawn straight through a station it does not call at reads as stopping
  // there: the symbol sits on its stroke, which is exactly how a stop is drawn. No
  // amount of symbol placement fixes it, because the two genuinely occupy the same
  // point — the layout has to give, by nudging the station off the alignment or by
  // making the line serve it.
  for (const overlap of findOverlaps(project, 'schematic', 0.75, net)) {
    if (overlap.kind !== 'mark-on-passing-line') continue
    issues.push({
      id: `through-${overlap.station}-${overlap.line}`,
      // Alongside is the renderer failing to separate two parallel lines, and worth a
      // warning. Merely crossing is a layout choice: the lines genuinely meet at that
      // point, and only moving the station or the alignment can change it.
      severity: overlap.alongside ? 'warning' : 'info',
      title: `"${overlap.lineName}" is drawn through ${overlap.stationName} without stopping`,
      detail: overlap.alongside
        ? 'It runs alongside this station without calling, but its stroke reaches the symbol, which reads as stopping.'
        : 'It crosses here without calling, and passes under the station symbol. Nudging the station off this alignment reads more clearly.',
      stationIds: [overlap.station],
      lineIds: overlap.line ? [overlap.line] : undefined,
    })
  }

  // --- colours ----------------------------------------------------------

  const visible = project.lines.filter((l) => !l.hidden)
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]
      const b = visible[j]
      const d = colorDistance(a.color, b.color)
      if (d >= COLOR_MIN_DISTANCE) continue

      // Only a real problem when the two actually run together somewhere.
      const shares = [...net.corridors.values()].some(
        (ids) => ids.includes(a.id) && ids.includes(b.id),
      )
      issues.push({
        id: `color-${a.id}-${b.id}`,
        severity: shares ? 'warning' : 'info',
        title: `"${a.name}" and "${b.name}" look alike`,
        detail: shares
          ? 'These two colours are hard to tell apart and the lines share a corridor, where they will be drawn side by side.'
          : 'These two colours are hard to tell apart, though the lines never run together.',
        lineIds: [a.id, b.id],
      })
    }
  }

  const rank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 }
  return issues.sort((x, y) => rank[x.severity] - rank[y.severity])
}

export function summarizeIssues(issues: Issue[]) {
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    infos: issues.filter((i) => i.severity === 'info').length,
  }
}
