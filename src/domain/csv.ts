/**
 * CSV import and export.
 *
 * Two shapes are accepted, both chosen to be things a spreadsheet or a game mod can
 * emit without ceremony:
 *
 *   stations:  name, x, y
 *   lines:     line, stop            (one row per stop, in order)
 *              line, stop, mode, colour, branch      (extra columns optional)
 *
 * The header row decides which is which. Station names are matched case-insensitively
 * against what already exists, so importing lines after stations links them up rather
 * than creating duplicates.
 *
 * `stationsToCsv` and `linesToCsv` write the same two shapes back out, so a project can
 * make a round trip through a spreadsheet.
 */

import { newBranchId, newLineId, newStationId } from './ids'
import { makeBranch, makeStation, nextUnusedColor } from './defaults'
import type { Branch, Line, Project, StationId } from './types'

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** RFC-4180-ish: handles quoted fields, escaped quotes, CRLF, and stray blank lines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else if (c !== '\r') field += c
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows.map((r) => r.map((f) => f.trim()))
}

export type CsvShape = 'stations' | 'lines' | 'unknown'

export function detectShape(header: string[]): CsvShape {
  const h = header.map((c) => c.toLowerCase())
  const has = (...names: string[]) => names.some((n) => h.includes(n))
  if (has('line', 'route') && has('stop', 'station', 'name')) return 'lines'
  if (has('name', 'station') && has('x', 'lon', 'lng', 'longitude')) return 'stations'
  return 'unknown'
}

const columnIndex = (header: string[], ...names: string[]): number => {
  const h = header.map((c) => c.toLowerCase())
  for (const n of names) {
    const i = h.indexOf(n)
    if (i >= 0) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface ImportReport {
  shape: CsvShape
  stationsAdded: number
  stationsMatched: number
  linesAdded: number
  stopsAdded: number
  warnings: string[]
}

/**
 * Apply parsed rows to a project draft. Runs inside an Immer recipe, so it mutates and
 * returns nothing; the whole import lands as a single undo step.
 */
export function applyCsv(draft: Project, rows: string[][]): ImportReport {
  const report: ImportReport = {
    shape: 'unknown',
    stationsAdded: 0,
    stationsMatched: 0,
    linesAdded: 0,
    stopsAdded: 0,
    warnings: [],
  }
  if (rows.length < 2) {
    report.warnings.push('The file has no data rows.')
    return report
  }

  const header = rows[0]
  const body = rows.slice(1)
  report.shape = detectShape(header)

  const byName = new Map<string, StationId>()
  for (const s of draft.stations) {
    if (s.name) byName.set(s.name.trim().toLowerCase(), s.id)
  }

  const addStation = (name: string, x: number, y: number): StationId => {
    const id = newStationId()
    draft.stations.push(makeStation(id, name, { x, y }))
    byName.set(name.trim().toLowerCase(), id)
    report.stationsAdded++
    return id
  }

  if (report.shape === 'stations') {
    const iName = columnIndex(header, 'name', 'station')
    const iX = columnIndex(header, 'x', 'lon', 'lng', 'longitude')
    const iY = columnIndex(header, 'y', 'lat', 'latitude')
    if (iName < 0 || iX < 0 || iY < 0) {
      report.warnings.push('Expected columns: name, x, y.')
      return report
    }

    for (const [n, r] of body.entries()) {
      const name = r[iName] ?? ''
      const x = Number(r[iX])
      const y = Number(r[iY])
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        report.warnings.push(`Row ${n + 2}: "${name || 'unnamed'}" has no usable coordinates.`)
        continue
      }
      const existing = name ? byName.get(name.trim().toLowerCase()) : undefined
      if (existing) {
        const s = draft.stations.find((st) => st.id === existing)
        if (s) {
          s.geo = { x, y }
          s.schematic = { x, y }
        }
        report.stationsMatched++
      } else {
        addStation(name, x, y)
      }
    }
    return report
  }

  if (report.shape === 'lines') {
    const iLine = columnIndex(header, 'line', 'route')
    const iStop = columnIndex(header, 'stop', 'station', 'name')
    const iMode = columnIndex(header, 'mode', 'type')
    const iColor = columnIndex(header, 'colour', 'color')
    const iBranch = columnIndex(header, 'branch')

    // Group rows by (line, branch), preserving file order — that order IS the route.
    const groups = new Map<string, { line: string; branch: string; stops: string[]; mode?: string; color?: string }>()
    for (const r of body) {
      const lineName = r[iLine] ?? ''
      const stopName = r[iStop] ?? ''
      if (!lineName || !stopName) continue
      const branch = iBranch >= 0 ? (r[iBranch] ?? '') : ''
      const key = `${lineName}\u0000${branch}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { line: lineName, branch, stops: [] }))
      g.stops.push(stopName)
      if (iMode >= 0 && r[iMode]) g.mode = r[iMode].toLowerCase()
      if (iColor >= 0 && r[iColor]) g.color = r[iColor]
    }

    const linesByName = new Map<string, Line>()
    for (const l of draft.lines) linesByName.set(l.name.trim().toLowerCase(), l)

    for (const g of groups.values()) {
      const stopIds: StationId[] = []
      for (const name of g.stops) {
        const key = name.trim().toLowerCase()
        let id = byName.get(key)
        if (!id) {
          // Unknown stations are created stacked at the origin; the validator will
          // flag them and you place them properly afterwards.
          id = addStation(name, 0, 0)
          report.warnings.push(`"${name}" was not in the project, so it was created at 0,0.`)
        } else {
          report.stationsMatched++
        }
        stopIds.push(id)
      }
      if (stopIds.length === 0) continue

      const lineKey = g.line.trim().toLowerCase()
      let line = linesByName.get(lineKey)
      if (!line) {
        const mode = g.mode && draft.modes.some((m) => m.id === g.mode) ? g.mode : 'metro'
        line = {
          id: newLineId(),
          name: g.line,
          mode,
          color: g.color?.startsWith('#')
            ? g.color
            : nextUnusedColor(draft.lines.map((l) => l.color)),
          branches: [],
          bends: {},
          hidden: false,
        }
        draft.lines.push(line)
        linesByName.set(lineKey, line)
        report.linesAdded++
      }

      const branch: Branch = makeBranch(newBranchId(), stopIds, {
        name: g.branch || undefined,
      })
      line.branches.push(branch)
      report.stopsAdded += stopIds.length
    }

    // A line created empty earlier would otherwise keep a stray blank branch.
    for (const l of draft.lines) {
      if (l.branches.length > 1) l.branches = l.branches.filter((b) => b.stops.length > 0)
      if (l.branches.length === 0) l.branches.push(makeBranch(newBranchId()))
    }
    return report
  }

  report.warnings.push(
    'Could not tell what this file is. Use a header row of "name,x,y" for stations, or "line,stop" for routes.',
  )
  return report
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const quote = (s: string) => (/[",;\t\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function stationsToCsv(project: Project): string {
  const rows = [['name', 'x', 'y', 'schematic_x', 'schematic_y']]
  for (const s of project.stations) {
    rows.push([
      s.name,
      String(Math.round(s.geo.x)),
      String(Math.round(s.geo.y)),
      String(Math.round(s.schematic.x)),
      String(Math.round(s.schematic.y)),
    ])
  }
  return rows.map((r) => r.map(quote).join(',')).join('\n')
}

export function linesToCsv(project: Project): string {
  const names = new Map(project.stations.map((s) => [s.id, s.name]))
  const rows = [['line', 'branch', 'stop', 'mode', 'colour']]
  for (const l of project.lines) {
    for (const [i, b] of l.branches.entries()) {
      for (const id of b.stops) {
        rows.push([l.name, b.name || `branch ${i + 1}`, names.get(id) ?? '', l.mode, l.color])
      }
    }
  }
  return rows.map((r) => r.map(quote).join(',')).join('\n')
}
