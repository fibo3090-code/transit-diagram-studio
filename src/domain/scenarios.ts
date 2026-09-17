/**
 * The awkward cases, as small networks.
 *
 * Every one of these is a shape that has broken the symbol logic at some point, or is
 * one step away from a shape that has. They exist so the drawing can be checked against
 * the meaning automatically (`overlaps.ts`) and looked at side by side in the lab route,
 * rather than being noticed on a real map weeks later.
 *
 * Kept deliberately tiny: four or five stations is enough to produce the collision, and
 * small enough that a failure points straight at the cause.
 */

import { createEmptyProject, makeBranch, makeStation } from './defaults'
import { newBranchId, newLineId, newStationId } from './ids'
import type { Branch, Line, Project, Station, StationId, Vec2 } from './types'

export interface Scenario {
  id: string
  title: string
  /** What is meant to be true of the drawing, in one line. */
  expectation: string
  project: Project
}

function build(name: string): {
  project: Project
  at: (name: string, x: number, y: number) => StationId
  line: (name: string, mode: string, color: string, branches: Branch[]) => Line
  branch: (stops: StationId[], extra?: Partial<Branch>) => Branch
} {
  const project = createEmptyProject(name)
  const at = (label: string, x: number, y: number): StationId => {
    const id = newStationId()
    const s: Station = makeStation(id, label, { x, y })
    project.stations.push(s)
    return id
  }
  const branch = (stops: StationId[], extra: Partial<Branch> = {}) =>
    makeBranch(newBranchId(), stops, extra)
  const line = (label: string, mode: string, color: string, branches: Branch[]): Line => {
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
  return { project, at, line, branch }
}

const P = (x: number, y: number): Vec2 => ({ x, y })
void P

export function scenarios(): Scenario[] {
  const out: Scenario[] = []

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Express beside a local')
    const s = [0, 1, 2, 3].map((i) => at(`S${i + 1}`, 100 + i * 120, 200))
    line('Local', 'metro', '#C9342B', [branch(s)])
    line('Express', 'rail', '#1B4F9C', [
      branch([s[0], s[3]], { passes: [s[1], s[2]] }),
    ])
    out.push({
      id: 'express-parallel',
      title: 'Express beside a local',
      expectation:
        'S2 and S3 carry a mark on the local only; the express stroke runs past them untouched.',
      project,
    })
  }

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Alternating skip-stop')
    const s = [0, 1, 2, 3, 4, 5].map((i) => at(`S${i + 1}`, 100 + i * 110, 200))
    // The Chicago pattern: two services that between them serve everything, each
    // skipping what the other calls at.
    line('A', 'metro', '#C9342B', [
      branch([s[0], s[2], s[4], s[5]], { passes: [s[1], s[3]] }),
    ])
    line('B', 'metro', '#1B4F9C', [
      branch([s[0], s[1], s[3], s[5]], { passes: [s[2], s[4]] }),
    ])
    out.push({
      id: 'skip-stop',
      title: 'Alternating skip-stop',
      expectation:
        'Every intermediate stop is served by exactly one of the two, and shows one mark on that track.',
      project,
    })
  }

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Wide and narrow side by side')
    const s = [0, 1, 2, 3].map((i) => at(`S${i + 1}`, 100 + i * 120, 200))
    // Rail is the widest stroke in the palette and cable the narrowest. A constant
    // corridor spacing has to hold both without the wide one swallowing the other's
    // mark.
    line('Heavy', 'rail', '#1B4F9C', [branch(s)])
    line('Light', 'cable', '#7A2E8E', [branch(s)])
    line('Middle', 'tram', '#00784F', [branch(s)])
    out.push({
      id: 'mixed-widths',
      title: 'Wide and narrow side by side',
      expectation: 'Three modes of different stroke widths share a corridor without their marks touching.',
      project,
    })
  }

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Express through a junction')
    const a = at('West', 100, 260)
    const b = at('Middle', 340, 260)
    const c = at('East', 580, 260)
    const n = at('North', 340, 80)
    const s2 = at('South', 340, 440)
    line('Local', 'metro', '#C9342B', [branch([a, b, c])])
    line('Express', 'rail', '#1B4F9C', [branch([a, c], { passes: [b] })])
    line('Cross', 'tram', '#00784F', [branch([n, b, s2])])
    out.push({
      id: 'junction-with-express',
      title: 'Express through a junction',
      expectation:
        'Middle is served by the local and the crossing tram, which get a mark each; the express does not.',
      project,
    })
  }

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Four services, two stop')
    const s = [0, 1, 2, 3].map((i) => at(`S${i + 1}`, 100 + i * 120, 200))
    line('L1', 'metro', '#C9342B', [branch(s)])
    line('L2', 'metro', '#B3187C', [branch(s)])
    line('X1', 'rail', '#1B4F9C', [branch([s[0], s[3]], { passes: [s[1], s[2]] })])
    line('X2', 'rail', '#12557A', [branch([s[0], s[3]], { passes: [s[1], s[2]] })])
    out.push({
      id: 'four-track',
      title: 'Four services, two stop',
      expectation:
        'A four-track corridor: two marks at S2 and S3, and two express strokes past them.',
      project,
    })
  }

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Express terminates mid-line')
    const s = [0, 1, 2, 3, 4].map((i) => at(`S${i + 1}`, 100 + i * 110, 200))
    line('Local', 'metro', '#C9342B', [branch(s)])
    // Runs fast over the first half and then terminates where the local carries on.
    line('Express', 'rail', '#1B4F9C', [branch([s[0], s[2]], { passes: [s[1]] })])
    out.push({
      id: 'express-terminates',
      title: 'Express terminates mid-line',
      expectation: 'S3 is an express terminus and a local stop; S4 and S5 are local only.',
      project,
    })
  }

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Express on a ring')
    const pts: StationId[] = [
      at('N', 300, 80),
      at('E', 520, 260),
      at('S', 300, 440),
      at('W', 80, 260),
    ]
    line('Circle', 'metro', '#D4A017', [branch([...pts, pts[0]], { name: 'circle' })])
    line('Fast', 'rail', '#1B4F9C', [
      branch([pts[0], pts[2], pts[0]], { passes: [pts[1], pts[3]], name: 'fast circle' }),
    ])
    out.push({
      id: 'ring-express',
      title: 'Express on a ring',
      expectation: 'Neither line has a terminus, and E and W show a mark on the circle only.',
      project,
    })
  }

  // -------------------------------------------------------------------------
  {
    const { project, at, line, branch } = build('Branch where only one side stops')
    const trunkA = at('Trunk A', 100, 260)
    const trunkB = at('Trunk B', 260, 260)
    const split = at('Split', 420, 260)
    const northA = at('North A', 580, 140)
    const southA = at('South A', 580, 380)
    line('Y', 'metro', '#6B4796', [
      branch([trunkA, trunkB, split, northA], { name: 'north' }),
      branch([split, southA], { name: 'south' }),
    ])
    line('Fast', 'rail', '#1B4F9C', [
      branch([trunkA, split, northA], { passes: [trunkB] }),
    ])
    out.push({
      id: 'branch-partial',
      title: 'Branch where only one side stops',
      expectation: 'Trunk B is local only; the fast service runs past it and then follows the north branch.',
      project,
    })
  }

  return out
}
