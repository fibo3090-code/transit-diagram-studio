/**
 * Starting shapes.
 *
 * A blank canvas is the worst moment in this tool: everything works, and there is
 * nothing to work on. These are not finished maps and are not meant to be — they are the
 * three skeletons real networks are built on, laid out to the app's own spacing so the
 * first thing you do is rename and extend rather than measure.
 *
 * Deliberately small. A template you have to delete half of is worse than a blank page.
 */

import { createEmptyProject, makeBranch, makeStation } from './defaults'
import { newBranchId, newLineId, newStationId } from './ids'
import type { Branch, Line, Project, StationId, Vec2 } from './types'

export interface Template {
  id: string
  name: string
  hint: string
}

export const TEMPLATES: Template[] = [
  {
    id: 'grid',
    name: 'Grid city',
    hint: 'Two avenues and two cross-streets, four interchanges in the middle',
  },
  {
    id: 'radial',
    name: 'Radial and ring',
    hint: 'Four spokes from the centre, tied together by a circle line',
  },
  {
    id: 'trunk',
    name: 'Trunk and branches',
    hint: 'A shared central corridor that splits at each end — the S-Bahn shape',
  },
]

/** Spacing that matches the shipped example, so a template and a real map agree. */
const STEP = 180

function builder(name: string) {
  const project = createEmptyProject(name)
  const at = (label: string, x: number, y: number): StationId => {
    const id = newStationId()
    project.stations.push(makeStation(id, label, { x, y }))
    return id
  }
  const branch = (stops: StationId[], extra: Partial<Branch> = {}) =>
    makeBranch(newBranchId(), stops, extra)
  const line = (label: string, mode: string, color: string, branches: Branch[]) => {
    const l: Line = {
      id: newLineId(),
      name: label,
      mode,
      color,
      branches,
      bends: {},
      hidden: false,
    }
    project.lines.push(l)
    return l
  }
  return { project, at, branch, line }
}

const P = (x: number, y: number): Vec2 => ({ x, y })
void P

export function createFromTemplate(id: string): Project {
  switch (id) {
    case 'radial':
      return radial()
    case 'trunk':
      return trunk()
    default:
      return grid()
  }
}

/** Two of each axis, crossing in the middle. Every crossing is an interchange. */
function grid(): Project {
  const { project, at, branch, line } = builder('Grid city')
  const xs = [1, 2, 3, 4, 5].map((i) => i * STEP)
  const ys = [1, 2, 3, 4, 5].map((i) => i * STEP)

  const across = (row: number, prefix: string) =>
    xs.map((x, i) => at(`${prefix} ${i + 1}`, x, ys[row]))
  const down = (col: number, prefix: string, known: Map<string, StationId>) =>
    ys.map((y, i) => {
      const key = `${xs[col]},${y}`
      const hit = known.get(key)
      return hit ?? at(`${prefix} ${i + 1}`, xs[col], y)
    })

  const known = new Map<string, StationId>()
  const rowA = across(1, 'North')
  rowA.forEach((id, i) => known.set(`${xs[i]},${ys[1]}`, id))
  const rowB = across(3, 'South')
  rowB.forEach((id, i) => known.set(`${xs[i]},${ys[3]}`, id))

  const colA = down(1, 'West', known)
  const colB = down(3, 'East', known)

  line('1', 'metro', '#C9342B', [branch(rowA)])
  line('2', 'metro', '#1B4F9C', [branch(rowB)])
  line('3', 'metro', '#00784F', [branch(colA)])
  line('4', 'metro', '#B45A0E', [branch(colB)])
  return project
}

/**
 * Two diameters through one centre, tied together by a circle.
 *
 * Diameters rather than four spokes on purpose: four lines that all START in the middle
 * put four terminus bullets on the same dot, which is both ugly and wrong. Real radial
 * networks run through the centre and out the other side.
 */
function radial(): Project {
  const { project, at, branch, line } = builder('Radial and ring')
  const cx = 3 * STEP
  const cy = 3 * STEP
  const centre = at('Central', cx, cy)

  const ringR = STEP * 1.5
  const gates = {
    n: at('North Gate', cx, cy - ringR),
    e: at('East Gate', cx + ringR, cy),
    s: at('South Gate', cx, cy + ringR),
    w: at('West Gate', cx - ringR, cy),
  }

  const outward = (label: string, dx: number, dy: number) => [
    at(`${label} 1`, cx + dx * ringR * 1.75, cy + dy * ringR * 1.75),
    at(`${label} 2`, cx + dx * ringR * 2.5, cy + dy * ringR * 2.5),
  ]

  const north = outward('North', 0, -1)
  const south = outward('South', 0, 1)
  const east = outward('East', 1, 0)
  const west = outward('West', -1, 0)

  line('1', 'metro', '#C9342B', [
    branch([...[...north].reverse(), gates.n, centre, gates.s, ...south]),
  ])
  line('2', 'metro', '#1B4F9C', [
    branch([...[...west].reverse(), gates.w, centre, gates.e, ...east]),
  ])
  // Closed on itself: a ring has no terminus, and the model knows it.
  line('C', 'rail', '#D4A017', [
    branch([gates.n, gates.e, gates.s, gates.w, gates.n], { name: 'circle' }),
  ])
  return project
}

/** One shared corridor down the middle, splitting at both ends. */
function trunk(): Project {
  const { project, at, branch, line } = builder('Trunk and branches')
  const y = 3 * STEP
  const core = [3, 4, 5, 6].map((i) => at(`Central ${i - 2}`, i * STEP, y))

  const westTop = [at('Northwest 2', 2 * STEP, y - STEP), at('Northwest 1', STEP, y - STEP * 1.6)]
  const westLow = [at('Southwest 2', 2 * STEP, y + STEP), at('Southwest 1', STEP, y + STEP * 1.6)]
  const eastTop = [at('Northeast 2', 7 * STEP, y - STEP), at('Northeast 1', 8 * STEP, y - STEP * 1.6)]
  const eastLow = [at('Southeast 2', 7 * STEP, y + STEP), at('Southeast 1', 8 * STEP, y + STEP * 1.6)]

  line('S1', 'rail', '#1B4F9C', [
    branch([...[...westTop].reverse(), ...core, ...eastTop], { name: 'north to north' }),
  ])
  line('S2', 'rail', '#00784F', [
    branch([...[...westLow].reverse(), ...core, ...eastLow], { name: 'south to south' }),
  ])
  // A third service over the trunk only, running fast: the reason the shape exists.
  line('S3', 'rail', '#C9342B', [
    branch([core[0], core[core.length - 1]], { passes: [core[1], core[2]] }),
  ])
  return project
}
