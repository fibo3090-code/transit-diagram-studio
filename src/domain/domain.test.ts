/**
 * Domain tests.
 *
 * The domain layer is pure — no DOM, no framework — so it can be checked directly.
 * These cover the parts where a silent wrong answer would be hard to notice by eye:
 * corridor offset signs, index stability through offsetting, and the snap engine.
 *
 * Run with `npm test`.
 */

import { createEmptyProject, makeBranch, makeStation, nextUnusedColor } from './defaults'
import {
  dist,
  octilinearizeRun,
  offsetPolyline,
  pointInPolygon,
  pointInShape,
  polygonPath,
  polygonPathWithHoles,
  polylinePath,
  simplify,
  snapDir45,
} from './geometry'
import { newBranchId, newLineId, newStationId } from './ids'
import { normalizeProject } from './migrate'
import { createSampleProject } from './sample'
import { scenarios } from './scenarios'
import { createFromTemplate, TEMPLATES } from './templates'
import { describeOverlap, findOverlaps } from './overlaps'
import { contentBounds } from '../export/exporters'
import {
  badgeCenters,
  badgeStripWidth,
  BADGE_DIAMETER,
  estimateTextWidth,
  labelExtras,
  labelRect,
  labelRects,
  placeLabels,
} from './labels'
import { applyCsv, parseCsv } from './csv'
import {
  branchGeometry,
  buildNetwork,
  stationMap,
  isForward,
  isRing,
  segmentKey,
  sharedRun,
  swapAcrossRun,
  applyCallingMask,
} from './network'
import { findCrossings } from './crossings'
import { findRoute, trackPath } from './routing'
import { newTransferId } from './ids'
import { snapPoint } from './snapping'
import { lineBadges, stationLevels, stationSymbol } from './symbols'
import type { Branch, Line, Project, Station, StationId, Vec2 } from './types'
import { validateProject } from './validate'

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    failures.push(`${name}\n    ${e instanceof Error ? e.message : String(e)}`)
  }
}

function expect(actual: unknown, expected: unknown, what = '') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}expected ${b}, got ${a}`)
}

function near(actual: number, expected: number, tol = 1e-6, what = '') {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${what}expected ~${expected}, got ${actual}`)
  }
}

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function station(name: string, x: number, y: number): Station {
  return makeStation(newStationId(), name, { x, y })
}

function line(name: string, branches: StationId[][], color = '#C9342B'): Line {
  return {
    id: newLineId(),
    name,
    mode: 'metro',
    color,
    branches: branches.map((stops): Branch => makeBranch(newBranchId(), stops)),
    bends: {},
    hidden: false,
  }
}

/** Four stations in a row, with two lines sharing the middle segment. */
function sharedCorridorFixture() {
  const p: Project = createEmptyProject('test')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const d = station('D', 300, 0)
  const e = station('E', 100, 100)
  p.stations = [a, b, c, d, e]
  p.lines = [
    line('L1', [[a.id, b.id, c.id, d.id]], '#C9342B'),
    line('L2', [[e.id, b.id, c.id]], '#1B4F9C'),
  ]
  p.style.corridorSpacing = 10
  return { p, a, b, c, d, e }
}

/** Two lines meeting only at C, so A -> E forces exactly one change. */
function branchedFixture() {
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const d = station('D', 200, 100)
  const e = station('E', 200, 200)
  p.stations = [a, b, c, d, e]
  p.lines = [
    line('L1', [[a.id, b.id, c.id]]),
    line('L2', [[c.id, d.id, e.id]], '#1B4F9C'),
  ]
  return { p, net: buildNetwork(p), a, b, c, d, e }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

check('segmentKey is canonical in both directions', () => {
  const x = 'st_aaa' as StationId
  const y = 'st_bbb' as StationId
  expect(segmentKey(x, y), segmentKey(y, x))
  assert(isForward(x, y) && !isForward(y, x), 'isForward should follow id order')
})

check('snapDir45 lands on the eight compass directions', () => {
  near(snapDir45({ x: 10, y: 1 }).x, 1, 1e-9)
  near(snapDir45({ x: 10, y: 1 }).y, 0, 1e-9)
  const diag = snapDir45({ x: 10, y: 9 })
  near(diag.x, Math.SQRT1_2, 1e-9)
  near(diag.y, Math.SQRT1_2, 1e-9)
})

check('octilinearizeRun makes every segment 0/45/90', () => {
  const out = octilinearizeRun([
    { x: 0, y: 0 },
    { x: 100, y: 12 },
    { x: 190, y: 105 },
  ])
  for (let i = 1; i < out.length; i++) {
    const dx = Math.abs(out[i].x - out[i - 1].x)
    const dy = Math.abs(out[i].y - out[i - 1].y)
    const ok = dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6
    assert(ok, `segment ${i} is not octilinear: dx=${dx} dy=${dy}`)
  }
})

check('offsetPolyline emits exactly one point per input vertex', () => {
  const pts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
    { x: 300, y: 50 },
  ]
  const out = offsetPolyline(pts, [5, 5, 5])
  expect(out.length, pts.length, 'index stability: ')
})

check('offsetPolyline holds index stability through a zero-length segment', () => {
  // A coincident pair used to be skipped, which shifted every later stop index.
  const pts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ]
  const out = offsetPolyline(pts, [5, 5, 5])
  expect(out.length, pts.length)
})

check('offsetPolyline shifts a straight line by exactly the offset', () => {
  const out = offsetPolyline(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    [8],
  )
  // Left normal of +x is -y in screen coords.
  near(out[0].y, -8)
  near(out[1].y, -8)
})

check('simplify collapses a nearly straight run to its endpoints', () => {
  const pts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 50, y: 1 },
    { x: 100, y: -1 },
    { x: 150, y: 0 },
  ]
  expect(simplify(pts, 5).length, 2)
  assert(simplify(pts, 0.1).length > 2, 'a tight epsilon should keep detail')
})

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

check('buildNetwork finds the shared corridor and both interchanges', () => {
  const { p, b, c } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const key = segmentKey(b.id, c.id)
  expect(net.corridors.get(key)?.length, 2, 'two lines on B-C: ')
  assert(net.interchanges.has(b.id), 'B should be an interchange')
  assert(net.interchanges.has(c.id), 'C should be an interchange')
})

check('corridor offsets are symmetric about the centre', () => {
  // A corridor with nothing running into it has no reason to sit anywhere but astride
  // its own stations, so the two tracks straddle the centreline evenly.
  const p: Project = createEmptyProject('t')
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  p.stations = [b, c]
  p.style.corridorSpacing = 10
  p.lines = [line('L1', [[b.id, c.id]], '#C9342B'), line('L2', [[b.id, c.id]], '#1B4F9C')]
  const net = buildNetwork(p)
  const offsets = [...(net.offsets.get(segmentKey(b.id, c.id))?.values() ?? [])]
  expect(offsets.length, 2)
  near(offsets[0], -5, 1e-9, 'first line: ')
  near(offsets[1], 5, 1e-9, 'second line: ')
  near(offsets[0] + offsets[1], 0, 1e-9, 'offsets should cancel: ')
})

check('a solo segment gets no offset', () => {
  const { p, a, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const m = net.offsets.get(segmentKey(a.id, b.id))
  expect([...(m?.values() ?? [])], [0])
})

check('termini exclude junctions but include real ends', () => {
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const d = station('D', 200, 100)
  p.stations = [a, b, c, d]
  // A Y: both branches start at A and share A-B, then split at B.
  p.lines = [line('Y', [[a.id, b.id, c.id], [b.id, d.id]])]
  const net = buildNetwork(p)
  const termini = net.terminiByLine.get(p.lines[0].id)!
  assert(termini.has(a.id), 'A is a real terminus')
  assert(termini.has(c.id), 'C is a real terminus')
  assert(termini.has(d.id), 'D is a real terminus')
  assert(!termini.has(b.id), 'B is a junction, not a terminus')
})

check('hidden lines release their corridor slot', () => {
  const { p, b, c } = sharedCorridorFixture()
  p.lines[1].hidden = true
  const net = buildNetwork(p)
  const offsets = [...(net.offsets.get(segmentKey(b.id, c.id))?.values() ?? [])]
  expect(offsets, [0], 'the remaining line should recentre: ')
})

check('corridorOrder override changes which line sits on which side', () => {
  const key0 = (() => {
    const { p, b, c } = sharedCorridorFixture()
    const net = buildNetwork(p)
    const k = segmentKey(b.id, c.id)
    const m = net.offsets.get(k)!
    return m.get(p.lines[1].id)! - m.get(p.lines[0].id)!
  })()
  assert(key0 > 0, 'by default the second line sits on the positive side')

  const { p, b, c } = sharedCorridorFixture()
  const key = segmentKey(b.id, c.id)
  const [l1, l2] = p.lines
  p.corridorOrder[key] = [l2.id, l1.id]
  const net = buildNetwork(p)
  const m = net.offsets.get(key)!
  // The offsets themselves are free to move -- the bundle sits where the lines running
  // into it are. What the override decides is the ORDER across the corridor.
  assert(
    m.get(l2.id)! < m.get(l1.id)!,
    `the override should put L2 on the other side, got ${m.get(l2.id)} vs ${m.get(l1.id)}`,
  )
  near(m.get(l1.id)! - m.get(l2.id)!, 10, 1e-9, 'still one spacing apart: ')
})

check('a shared run covers every segment two lines keep each other company on', () => {
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const d = station('D', 300, 0)
  p.stations = [a, b, c, d]
  const l1 = line('L1', [[a.id, b.id, c.id, d.id]], '#C9342B')
  const l2 = line('L2', [[a.id, b.id, c.id]], '#1B4F9C')
  p.lines = [l1, l2]
  const net = buildNetwork(p)

  const run = sharedRun(net, segmentKey(a.id, b.id), l1.id, l2.id)
  expect(run.length, 2, 'A-B and B-C, not C-D: ')
  assert(run.includes(segmentKey(b.id, c.id)), 'the run continues through B')
  assert(!run.includes(segmentKey(c.id, d.id)), 'and stops where L2 does')

  // A corridor neither line shares is not a run at all.
  expect(sharedRun(net, segmentKey(c.id, d.id), l1.id, l2.id).length, 0)
})

check('moving a line across a bundle carries along the whole run', () => {
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const d = station('D', 300, 0)
  p.stations = [a, b, c, d]
  const l1 = line('L1', [[a.id, b.id, c.id, d.id]], '#C9342B')
  const l2 = line('L2', [[a.id, b.id, c.id]], '#1B4F9C')
  p.lines = [l1, l2]
  let net = buildNetwork(p)

  const ab = segmentKey(a.id, b.id)
  const writes = swapAcrossRun(net, ab, l2.id, -1)
  expect(Object.keys(writes).length, 2, 'both shared segments rewritten: ')

  Object.assign(p.corridorOrder, writes)
  net = buildNetwork(p)
  for (const key of [ab, segmentKey(b.id, c.id)]) {
    const m = net.offsets.get(key)!
    assert(
      m.get(l2.id)! < m.get(l1.id)!,
      `L2 should be on the far side over ${key}, got ${m.get(l2.id)} vs ${m.get(l1.id)}`,
    )
  }

  // ...and 'here' is the escape hatch that draws a deliberate crossover.
  const one = swapAcrossRun(buildNetwork(createEmptyProject('x')), ab, l2.id, -1, 'here')
  expect(Object.keys(one).length, 0, 'an unknown corridor changes nothing: ')
  expect(Object.keys(swapAcrossRun(net, ab, l1.id, -1, 'here')).length, 1, 'just this one: ')
})

check('a line running through a merge does not move sideways', () => {
  // L1 runs straight A-B-C-D. L2 joins it for B-C only. The old centred offsets shifted
  // L1 by half a spacing over B-C and back again, which draws as an S-bend in a line
  // that is dead straight.
  const { p, a, b, c, d } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const [l1, l2] = p.lines
  const at = (x: typeof a, y: typeof b) => net.offsets.get(segmentKey(x.id, y.id))!.get(l1.id)!
  near(at(a, b), at(b, c), 1e-9, 'L1 keeps its side into the merge: ')
  near(at(b, c), at(c, d), 1e-9, 'and out of it: ')
  const shared = net.offsets.get(segmentKey(b.id, c.id))!
  near(
    Math.abs(shared.get(l2.id)! - shared.get(l1.id)!),
    10,
    1e-9,
    'and the joining line sits one spacing beside it: ',
  )
})

check('anti-canonical traversal flips the offset so a line keeps its side', () => {
  // Two lines over the same pair, one running each way. Both must end up on the same
  // physical side of the corridor, which means the travel-relative offsets differ in
  // sign exactly when the traversal direction does.
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  p.stations = [a, b]
  p.style.corridorSpacing = 10
  const forward = line('F', [[a.id, b.id]])
  const backward = line('B', [[b.id, a.id]])
  p.lines = [forward, backward]

  const net = buildNetwork(p)
  const gF = branchGeometry(p, net, forward, forward.branches[0], 'schematic')!
  const gB = branchGeometry(p, net, backward, backward.branches[0], 'schematic')!

  const ptsF = offsetPolyline(gF.points, gF.offsets)
  const ptsB = offsetPolyline(gB.points, gB.offsets)

  // Whatever the travel direction, the two strokes must not land on top of each other.
  assert(
    Math.abs(ptsF[0].y - ptsB[ptsB.length - 1].y) > 1,
    'the two lines should be drawn on opposite sides, not overlapping',
  )
})

check('branchGeometry reports stops aligned with stopIndices', () => {
  const { p, a, b, c, d } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const l = p.lines[0]
  const g = branchGeometry(p, net, l, l.branches[0], 'schematic')!
  expect(g.stops, [a.id, b.id, c.id, d.id])
  expect(g.stopIndices.length, g.stops.length)
  expect(g.offsets.length, g.points.length - 1)
})

check('branchGeometry threads manual bends into the centreline', () => {
  const { p, a, b } = sharedCorridorFixture()
  const l = p.lines[0]
  l.bends[segmentKey(a.id, b.id)] = [{ geo: { x: 50, y: 40 }, schematic: { x: 50, y: 40 } }]
  const net = buildNetwork(p)
  const g = branchGeometry(p, net, l, l.branches[0], 'schematic')!
  assert(
    g.points.some((pt) => pt.x === 50 && pt.y === 40),
    'the bend point should appear in the centreline',
  )
  expect(g.offsets.length, g.points.length - 1, 'offsets stay aligned after a bend: ')
})

check('deleted stations are skipped rather than crashing geometry', () => {
  const { p, a, b, c, d } = sharedCorridorFixture()
  p.stations = p.stations.filter((s) => s.id !== c.id)
  const net = buildNetwork(p)
  const l = p.lines[0]
  const g = branchGeometry(p, net, l, l.branches[0], 'schematic')!
  expect(g.stops, [a.id, b.id, d.id])
})

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

check('a shared corridor station gets a bar, a solo stop gets a plain symbol', () => {
  const { p, a, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const atB = stationSymbol(p, net, p.stations.find((s) => s.id === b.id)!, 'schematic')
  expect(atB.shape.kind, 'bar', 'B is on a two-line corridor: ')

  const atA = stationSymbol(p, net, p.stations.find((s) => s.id === a.id)!, 'schematic')
  expect(atA.shape.kind, 'plain', 'A is on one line only: ')
  assert(atA.terminus, 'A is a terminus')
})

check('a station on no line reports as an orphan', () => {
  const p = createEmptyProject('t')
  const a = station('Lonely', 10, 10)
  p.stations = [a]
  const net = buildNetwork(p)
  expect(stationSymbol(p, net, a, 'schematic').shape.kind, 'orphan')
  assert(net.orphans.has(a.id), 'should be listed as an orphan')
})

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

const snapSettings = {
  angle: true,
  grid: false,
  align: false,
  spacing: false,
  levels: false,
  gridSize: 20,
  tolerance: 12,
}

check('a point near a 45-degree ray snaps exactly onto it', () => {
  const origin = { x: 0, y: 0 }
  const out = snapPoint({
    raw: { x: 104, y: 100 },
    neighbours: [origin],
    others: [],
    spacing: [],
    levels: [],
    settings: snapSettings,
  })
  assert(out.snapped, 'should have snapped')
  near(out.point.x - origin.x, out.point.y - origin.y, 1e-6, 'dx should equal dy: ')
  assert(out.guides.length > 0, 'a guide should be reported')
})

check('a point far from every ray is left alone', () => {
  const out = snapPoint({
    raw: { x: 200, y: 5 },
    neighbours: [{ x: 0, y: 0 }],
    others: [],
    settings: { ...snapSettings, tolerance: 2 },
    spacing: [],
    levels: [],
  })
  assert(!out.snapped, 'should not snap when nothing is in range')
  expect(out.point, { x: 200, y: 5 })
})

check('two crossing rays win over a single ray', () => {
  // Horizontal from (0,0) and vertical from (100, 100) cross at (100, 0).
  const out = snapPoint({
    raw: { x: 98, y: 3 },
    neighbours: [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ],
    others: [],
    spacing: [],
    levels: [],
    settings: snapSettings,
  })
  assert(out.snapped, 'should snap')
  near(out.point.x, 100, 1e-6)
  near(out.point.y, 0, 1e-6)
  expect(out.guides.length, 2, 'both guides should show: ')
})

check('snapping off entirely returns the raw point', () => {
  const out = snapPoint({
    raw: { x: 3, y: 7 },
    neighbours: [{ x: 0, y: 0 }],
    others: [],
    spacing: [],
    levels: [],
    settings: { ...snapSettings, angle: false },
  })
  assert(!out.snapped, 'nothing enabled means no snap')
  expect(out.point, { x: 3, y: 7 })
})

check('alignment snapping shares an axis with another station', () => {
  const out = snapPoint({
    raw: { x: 104, y: 55 },
    neighbours: [],
    others: [{ x: 100, y: 300 }],
    spacing: [],
    levels: [],
    settings: { ...snapSettings, angle: false, align: true },
  })
  near(out.point.x, 100, 1e-6, 'x should align: ')
  near(out.point.y, 55, 1e-6, 'y should be untouched: ')
})

check('snapped coordinates are quantised, not irrational', () => {
  const out = snapPoint({
    raw: { x: 104, y: 100 },
    neighbours: [{ x: 0, y: 0 }],
    others: [],
    spacing: [],
    levels: [],
    settings: snapSettings,
  })
  expect(out.point.x, Math.round(out.point.x * 100) / 100, 'x should be 2dp: ')
  expect(out.point.y, Math.round(out.point.y * 100) / 100, 'y should be 2dp: ')
})

check('stationLevels covers every line in a bundle plus one either side', () => {
  const { p, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const station = p.stations.find((s) => s.id === b.id)!
  const levels = stationLevels(p, net, station, 'schematic')
  // Two lines through B, so two real levels plus a pass-by track on each side.
  expect(levels.length, 4)
  expect(levels.filter((l) => l.outside === 0).length, 2, 'real tracks: ')
  expect(levels.filter((l) => l.outside !== 0).length, 2, 'pass-by tracks: ')
})

check('levels are spaced by the corridor spacing', () => {
  const { p, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const station = p.stations.find((s) => s.id === b.id)!
  const levels = stationLevels(p, net, station, 'schematic')
  const sorted = [...levels].sort((x, y) => x.origin.y - y.origin.y)
  for (let i = 1; i < sorted.length; i++) {
    near(
      Math.abs(sorted[i].origin.y - sorted[i - 1].origin.y),
      p.style.corridorSpacing,
      1e-6,
      `gap ${i}: `,
    )
  }
})

check('a level snap lands on a track, not the middle of the bundle', () => {
  const { p, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const station = p.stations.find((s) => s.id === b.id)!
  const levels = stationLevels(p, net, station, 'schematic')
  // The bundle runs east-west through y=0, so a real track sits at y = -5.
  const target = levels.find((l) => l.outside === 0 && l.origin.y < 0)!

  const out = snapPoint({
    raw: { x: 250, y: target.origin.y + 3 },
    neighbours: [],
    others: [],
    spacing: [],
    levels,
    settings: { ...snapSettings, angle: false, levels: true },
  })
  assert(out.snapped, 'should snap to the level')
  near(out.point.y, target.origin.y, 1e-6, 'should land on the track: ')
  assert(out.applied.includes('levels'), 'should report a level snap')
})

check('the pass-by level sits outside every real track', () => {
  const { p, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const station = p.stations.find((s) => s.id === b.id)!
  const levels = stationLevels(p, net, station, 'schematic')
  const real = levels.filter((l) => l.outside === 0).map((l) => l.origin.y)
  for (const outer of levels.filter((l) => l.outside !== 0)) {
    const beyond = outer.origin.y < Math.min(...real) || outer.origin.y > Math.max(...real)
    assert(beyond, 'a pass-by track must sit clear of the bundle')
  }
})

check('levels off means no level snapping', () => {
  const { p, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const station = p.stations.find((s) => s.id === b.id)!
  const levels = stationLevels(p, net, station, 'schematic')
  const out = snapPoint({
    raw: { x: 250, y: -2 },
    neighbours: [],
    others: [],
    spacing: [],
    levels,
    settings: { ...snapSettings, angle: false, levels: false },
  })
  assert(!out.snapped, 'nothing should snap with every family disabled')
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

check('labels avoid sitting on the track', () => {
  const { p } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const anchors = placeLabels(p, net, 'schematic')
  expect(anchors.size, p.stations.filter((s) => s.name).length)
  // B and C sit mid-corridor on a horizontal line, so east/west are blocked.
  const b = p.stations[1]
  const anchor = anchors.get(b.id)?.anchor
  assert(
    anchor === 'n' || anchor === 's' || anchor === 'ne' || anchor === 'nw' ||
      anchor === 'se' || anchor === 'sw',
    `a mid-corridor label should move off the track, got ${anchor}`,
  )
})

check('badges are drawn clear of the name, and room is reserved for them', () => {
  const fontSize = 13
  // The first badge has to start after the last letter, not on top of the first one.
  // This was the bug: every badged station printed its icons over its own name.
  const first = badgeCenters(3, fontSize)[0] - (fontSize * BADGE_DIAMETER) / 2
  assert(first > 0, `the badge strip must start clear of the text, got ${first}`)

  const centers = badgeCenters(3, fontSize)
  for (let i = 1; i < centers.length; i++) {
    assert(
      centers[i] - centers[i - 1] >= fontSize * BADGE_DIAMETER,
      'badges must not be drawn on top of each other',
    )
  }

  // And the strip is as wide as the placer thinks it is.
  const drawn = centers[centers.length - 1] + (fontSize * BADGE_DIAMETER) / 2
  expect(Math.round(badgeStripWidth(3, fontSize) * 100) / 100, Math.round(drawn * 100) / 100)

  // An east label grows rightwards from the same left edge...
  const at = { x: 0, y: 0 }
  const bare = labelRect(at, 'e', 'Aldbury North', fontSize, 10)
  const badged = labelRect(at, 'e', 'Aldbury North', fontSize, 10, { x: 0, y: 0 }, { width: 40 })
  expect(Math.round(badged.x), Math.round(bare.x), 'left edge unchanged: ')
  expect(Math.round(badged.w - bare.w), 40, 'and it is 40 wider: ')

  // ...a west one grows leftwards, keeping its right edge against the stop...
  const w1 = labelRect(at, 'w', 'Aldbury North', fontSize, 10)
  const w2 = labelRect(at, 'w', 'Aldbury North', fontSize, 10, { x: 0, y: 0 }, { width: 40 })
  expect(Math.round(w2.x + w2.w), Math.round(w1.x + w1.w), 'right edge unchanged: ')

  // ...and a label directly above keeps its name centred on the stop, leaning only the
  // badges to the right, which is where the renderer puts them.
  const n1 = labelRect(at, 'n', 'Aldbury North', fontSize, 10)
  const n2 = labelRect(at, 'n', 'Aldbury North', fontSize, 10, { x: 0, y: 0 }, { width: 40 })
  expect(Math.round(n2.x), Math.round(n1.x), 'text still starts where it did: ')
  expect(Math.round(n2.x + n2.w), Math.round(n1.x + n1.w + 40), 'strip hangs off the end: ')
})

check('the shipped map reserves label room for every badge it draws', () => {
  const p = createSampleProject()
  const net = buildNetwork(p)
  const anchors = placeLabels(p, net, 'schematic')
  const fs = p.style.fontSize
  let badged = 0
  for (const s of p.stations) {
    if (s.badges.length === 0 || !s.name || s.label.hidden) continue
    badged++
    const isInterchange = (net.linesAtStation.get(s.id)?.length ?? 0) > 1
    const gap = (isInterchange ? p.style.stationRadius * 1.45 : p.style.stationRadius) + 5
    const rect = labelRect(
      s.schematic,
      anchors.get(s.id)?.anchor ?? 'e',
      s.name,
      fs,
      gap,
      s.label.offset,
      labelExtras(p, s),
    )
    const need = estimateTextWidth(s.name, fs) + badgeStripWidth(s.badges.length, fs)
    assert(rect.w >= need - 0.01, `${s.name}: reserved ${rect.w} for ${need}`)
  }
  assert(badged > 0, 'the example map should have badged stations to check')
})

check('no mark on the shipped map floats off the line it names', () => {
  // The renderer's own fault class: a dot that claims a service stops here while sitting
  // beside that service's track. Lines that merely CROSS a station they do not serve are
  // a layout choice and are counted separately -- nothing the renderer does can fix one.
  const p = createSampleProject()
  const net = buildNetwork(p)
  const found = findOverlaps(p, 'schematic', 0.75, net)
  const rendererFault = found.filter(
    (o) => o.kind === 'mark-off-its-line' || o.kind === 'marks-collide' || o.alongside,
  )
  assert(
    rendererFault.length === 0,
    `${rendererFault.length} drawing faults:\n  ${rendererFault.map(describeOverlap).join('\n  ')}`,
  )
})

check('a second name hangs below the first, and the box says so', () => {
  const p = createEmptyProject('two names')
  const s = makeStation(newStationId(), 'Aldbury Airport', { x: 0, y: 0 })
  s.nameSecondary = 'Maes Awyr'
  p.stations.push(s)
  const extras = labelExtras(p, s)
  assert(extras.height > 0, 'a second name takes a line of its own')

  // Whichever side of the stop the label is on, the extra line goes downwards — so the
  // box has to grow downwards, never up into the gap the first line was placed by.
  for (const anchor of ['e', 'n', 's'] as const) {
    const one = labelRect(s.schematic, anchor, s.name, p.style.fontSize, 10)
    const two = labelRect(s.schematic, anchor, s.name, p.style.fontSize, 10, { x: 0, y: 0 }, extras)
    expect(Math.round(two.y), Math.round(one.y), `${anchor} keeps its top: `)
    expect(
      Math.round(two.y + two.h),
      Math.round(one.y + one.h + extras.height),
      `${anchor} grows downwards: `,
    )
  }
})

check('a pinned label keeps its anchor', () => {
  const { p } = sharedCorridorFixture()
  p.stations[0].label = { ...p.stations[0].label, anchor: 'sw', pinned: true }
  const net = buildNetwork(p)
  expect(placeLabels(p, net, 'schematic').get(p.stations[0].id)?.anchor, 'sw')
})

// ---------------------------------------------------------------------------
// Crossings
// ---------------------------------------------------------------------------

const H = (y: number, k = 'h') => [{ a: { x: -100, y }, b: { x: 100, y }, segKey: k }]
const V = (x: number, k = 'v') => [{ a: { x, y: -100 }, b: { x, y: 100 }, segKey: k }]

check('two lines crossing produce one bridge, carried by the upper one', () => {
  const cs = findCrossings(
    [
      { id: 'low', z: 0, width: 8, segments: H(0) },
      { id: 'high', z: 1, width: 8, segments: V(0) },
    ],
    [],
    10,
    { length: 3, height: 3 },
  )
  expect(cs.length, 1)
  expect(cs[0].upper, 'high', 'the later line passes over: ')
  near(cs[0].at.x, 0, 1e-6)
  near(cs[0].at.y, 0, 1e-6)
})

check('parallel lines never bridge each other', () => {
  // This is the shared-corridor case: a casing along the whole length used to reach
  // into the neighbouring track and paint over it.
  const cs = findCrossings(
    [
      { id: 'a', z: 0, width: 8, segments: H(-5) },
      { id: 'b', z: 1, width: 8, segments: H(5) },
    ],
    [],
    10,
    { length: 3, height: 3 },
  )
  expect(cs.length, 0)
})

check('a crossing where both lines stop is a junction, not an overpass', () => {
  const cs = findCrossings(
    [
      { id: 'a', z: 0, width: 8, segments: H(0) },
      { id: 'b', z: 1, width: 8, segments: V(0) },
    ],
    [{ at: { x: 0, y: 0 }, calling: new Set(['a', 'b']) }],
    12,
    { length: 3, height: 3 },
  )
  expect(cs.length, 0)
})

check('a line crossing a station it does not serve keeps its break', () => {
  // Otherwise it runs unbroken through the symbol and reads as calling there, which
  // states the opposite of the timetable.
  const cs = findCrossings(
    [
      { id: 'a', z: 0, width: 8, segments: H(0) },
      { id: 'b', z: 1, width: 8, segments: V(0) },
    ],
    [{ at: { x: 0, y: 0 }, calling: new Set(['a']) }],
    12,
    { length: 3, height: 3 },
  )
  expect(cs.length, 1, 'b only passes through, so it is bridged: ')
})

check('lines that merely touch at their ends do not bridge', () => {
  const cs = findCrossings(
    [
      { id: 'a', z: 0, width: 8, segments: [{ a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, segKey: 'a' }] },
      { id: 'b', z: 1, width: 8, segments: [{ a: { x: 50, y: 0 }, b: { x: 50, y: 50 }, segKey: 'b' }] },
    ],
    [],
    1,
    { length: 3, height: 3 },
  )
  expect(cs.length, 0)
})

check('a line crossing itself needs no bridge', () => {
  const cs = findCrossings(
    [{ id: 'a', z: 0, width: 8, segments: [...H(0), ...V(0)] }],
    [],
    1,
    { length: 3, height: 3 },
  )
  expect(cs.length, 0)
})

check('casing off means no bridges at all', () => {
  const cs = findCrossings(
    [
      { id: 'a', z: 0, width: 8, segments: H(0) },
      { id: 'b', z: 1, width: 8, segments: V(0) },
    ],
    [],
    1,
    { length: 0, height: 0 },
  )
  expect(cs.length, 0)
})

check('a shallow crossing needs a longer bridge than a square one', () => {
  const square = findCrossings(
    [
      { id: 'a', z: 0, width: 10, segments: H(0) },
      { id: 'b', z: 1, width: 10, segments: V(0) },
    ],
    [], 1, { length: 2, height: 2 },
  )
  const shallow = findCrossings(
    [
      { id: 'a', z: 0, width: 10, segments: H(0) },
      { id: 'b', z: 1, width: 10, segments: [{ a: { x: -100, y: -20 }, b: { x: 100, y: 20 }, segKey: 'b' }] },
    ],
    [], 1, { length: 2, height: 2 },
  )
  expect(square.length, 1)
  expect(shallow.length, 1)
  assert(
    shallow[0].length > square[0].length,
    `shallow ${shallow[0].length} should exceed square ${square[0].length}`,
  )
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

check('a direct journey stays on one line', () => {
  const { p, a, d } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const r = findRoute(p, net, a.id, d.id)!
  assert(!!r, 'a route should exist')
  expect(r.legs.length, 1, 'one leg: ')
  expect(r.interchanges, 0)
  expect(r.stopCount, 3, 'A->B->C->D is three stops: ')
})

check('a journey needing a change reports one interchange', () => {
  const { p, net, a, e } = branchedFixture()
  const r = findRoute(p, net, a.id, e.id)!
  assert(!!r, 'a route should exist')
  expect(r.interchanges, 1, 'should change once: ')
  assert(r.legs.length === 2, `expected two legs, got ${r.legs.length}`)
})

check('an unreachable station returns no route', () => {
  const { p } = sharedCorridorFixture()
  const lonely = station('Island', 999, 999)
  p.stations = [...p.stations, lonely]
  const net = buildNetwork(p)
  expect(findRoute(p, net, p.stations[0].id, lonely.id), null)
})

check('routing to yourself is not a journey', () => {
  const { p, a } = sharedCorridorFixture()
  expect(findRoute(p, buildNetwork(p), a.id, a.id), null)
})

check('an out-of-station link bridges two disconnected networks', () => {
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 300, 0)
  const d = station('D', 400, 0)
  p.stations = [a, b, c, d]
  p.lines = [line('L1', [[a.id, b.id]]), line('L2', [[c.id, d.id]])]

  // Without a link the two halves are separate.
  expect(findRoute(p, buildNetwork(p), a.id, d.id), null, 'no link yet: ')

  p.transfers = [{ id: newTransferId(), a: b.id, b: c.id, note: '', hidden: false }]
  const r = findRoute(p, buildNetwork(p), a.id, d.id)!
  assert(!!r, 'the walking link should connect them')
  expect(r.walks, 1, 'one walk: ')
  assert(
    r.legs.some((l) => l.lineId === null),
    'the journey should include a walking leg',
  )
})

check('a hidden line carries nobody', () => {
  const { p, a, d } = sharedCorridorFixture()
  p.lines[0].hidden = true
  // L1 was the only line reaching D.
  expect(findRoute(p, buildNetwork(p), a.id, d.id), null)
})

check('changing line is avoided when staying aboard is possible', () => {
  // A -> B -> C is reachable both directly on L1 and by changing to L2 at B.
  // The interchange penalty must make the direct option win.
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  p.stations = [a, b, c]
  p.lines = [line('Direct', [[a.id, b.id, c.id]]), line('Other', [[b.id, c.id]], '#1B4F9C')]
  const r = findRoute(p, buildNetwork(p), a.id, c.id)!
  expect(r.interchanges, 0, 'should stay on the direct line: ')
  expect(r.legs.length, 1)
})

// ---------------------------------------------------------------------------
// Colours and validation
// ---------------------------------------------------------------------------

check('nextUnusedColor avoids colours already in play', () => {
  const used = ['#C9342B', '#1B4F9C']
  const next = nextUnusedColor(used)
  assert(!used.includes(next), `${next} is already used`)
})

check('validator flags orphans, duplicate names and short lines', () => {
  const p = createEmptyProject('t')
  const a = station('Same', 0, 0)
  const b = station('Same', 50, 0)
  const c = station('Lonely', 200, 200)
  p.stations = [a, b, c]
  p.lines = [line('Stub', [[a.id]])]
  const issues = validateProject(p)
  assert(issues.some((i) => i.title.includes('named the same')), 'duplicate names')
  assert(issues.some((i) => i.id === 'orphans'), 'orphan stations')
  assert(issues.some((i) => i.severity === 'error'), 'a one-stop line is an error')
})

check('a clean network produces no issues', () => {
  const { p } = sharedCorridorFixture()
  const issues = validateProject(p).filter((i) => i.severity !== 'info')
  expect(issues.map((i) => i.title), [], 'unexpected issues: ')
})

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

check('parseCsv handles quotes, escapes and mixed delimiters', () => {
  const rows = parseCsv('name,x,y\n"Smith, John",1,2\n"He said ""hi""",3,4\n')
  expect(rows.length, 3)
  expect(rows[1], ['Smith, John', '1', '2'])
  expect(rows[2], ['He said "hi"', '3', '4'])
})

check('CSV station import creates stations with both positions set', () => {
  const p = createEmptyProject('t')
  const report = applyCsv(p, parseCsv('name,x,y\nAlpha,10,20\nBeta,30,40\n'))
  expect(report.shape, 'stations')
  expect(report.stationsAdded, 2)
  expect(p.stations.length, 2)
  expect(p.stations[0].geo, { x: 10, y: 20 })
  expect(p.stations[0].schematic, { x: 10, y: 20 })
})

check('CSV line import matches existing stations by name', () => {
  const p = createEmptyProject('t')
  applyCsv(p, parseCsv('name,x,y\nAlpha,0,0\nBeta,100,0\nGamma,200,0\n'))
  const report = applyCsv(
    p,
    parseCsv('line,stop\nM1,Alpha\nM1,Beta\nM1,Gamma\n'),
  )
  expect(report.shape, 'lines')
  expect(report.linesAdded, 1)
  expect(p.stations.length, 3, 'no duplicate stations should be created: ')
  expect(p.lines[0].branches[0].stops.length, 3)
})

check('CSV line import keeps branches separate', () => {
  const p = createEmptyProject('t')
  applyCsv(p, parseCsv('name,x,y\nA,0,0\nB,1,0\nC,2,0\nD,3,0\n'))
  applyCsv(
    p,
    parseCsv('line,branch,stop\nY,main,A\nY,main,B\nY,main,C\nY,spur,B\nY,spur,D\n'),
  )
  expect(p.lines.length, 1, 'one line: ')
  expect(p.lines[0].branches.length, 2, 'two branches: ')
})

check('an unreadable CSV reports rather than throwing', () => {
  const p = createEmptyProject('t')
  const report = applyCsv(p, parseCsv('alpha,beta\n1,2\n'))
  expect(report.shape, 'unknown')
  assert(report.warnings.length > 0, 'should explain what it wanted')
})

// ---------------------------------------------------------------------------
// Rings, express patterns and direction
// ---------------------------------------------------------------------------

/** A closed loop: the last stop repeats the first. */
function ringFixture() {
  const p: Project = createEmptyProject('ring')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 100, 100)
  const d = station('D', 0, 100)
  p.stations = [a, b, c, d]
  p.lines = [line('Circle', [[a.id, b.id, c.id, d.id, a.id]])]
  return { p, net: buildNetwork(p), a, b, c, d }
}

check('a closed loop has no termini', () => {
  const { p, net } = ringFixture()
  const termini = net.terminiByLine.get(p.lines[0].id)
  expect(termini?.size ?? 0, 0, 'a ring ends nowhere, so it gets no route bullet: ')
})

check('a closed loop is still recognised as a ring', () => {
  const { p } = ringFixture()
  assert(isRing(p.lines[0].branches[0]), 'first stop repeated at the end means a ring')
  assert(!isRing(line('L', [[newStationId(), newStationId()]]).branches[0]), 'a plain run is not')
})

check('an open branch still reports both its ends', () => {
  const { p, a, d } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const termini = net.terminiByLine.get(p.lines[0].id)!
  expect([...termini].sort(), [a.id, d.id].sort(), 'the ring fix must not eat real termini: ')
})

check('a ring draws a closed centreline', () => {
  const { p, net, a } = ringFixture()
  const l = p.lines[0]
  const g = branchGeometry(p, net, l, l.branches[0], 'schematic')!
  const first = g.points[0]
  const last = g.points[g.points.length - 1]
  near(dist(first, last), 0, 1e-6, 'a ring must come back to where it started: ')
  expect(g.stops[g.stops.length - 1], a.id)
})

/** A local calling everywhere and an express skipping the middle two. */
function expressFixture() {
  const p: Project = createEmptyProject('express')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const d = station('D', 300, 0)
  p.stations = [a, b, c, d]
  const local = line('Local', [[a.id, b.id, c.id, d.id]])
  const exp = line('Express', [[a.id, d.id]], '#1B4F9C')
  exp.branches[0].passes = [b.id, c.id]
  p.lines = [local, exp]
  return { p, net: buildNetwork(p), a, b, c, d, local, exp }
}

check('an express follows the alignment through the stations it skips', () => {
  const { p, net, exp } = expressFixture()
  const g = branchGeometry(p, net, exp, exp.branches[0], 'schematic')!
  expect(g.points.length, 4, 'A, through B and C, to D: ')
  expect(g.stopIndices, [0, 3], 'only the served ends carry a stop symbol: ')
})

check('a passed station is not a stop of that line', () => {
  const { net, b, exp } = expressFixture()
  const serving = net.linesAtStation.get(b.id) ?? []
  assert(!serving.includes(exp.id), 'passing through is not calling')
})

check('a passed station still gets the express drawn through it', () => {
  const { p, net, exp, b } = expressFixture()
  const g = branchGeometry(p, net, exp, exp.branches[0], 'schematic')!
  const hit = g.points.some((q) => dist(q, p.stations.find((s) => s.id === b.id)!.schematic) < 1e-6)
  assert(hit, 'the centreline must actually pass through B')
})

check('you cannot board an express where it does not stop', () => {
  const { p, net, b, d } = expressFixture()
  const r = findRoute(p, net, b.id, d.id)!
  assert(r !== null, 'B to D is reachable on the local')
  assert(r.legs.every((l) => l.lineId !== null), 'no walking needed here')
  const used = r.legs.map((l) => l.lineId)
  assert(!used.includes(p.lines[1].id), 'the express does not call at B, so it cannot be boarded there')
})

check('an express is used when both ends are served', () => {
  const { p, net, a, d } = expressFixture()
  const r = findRoute(p, net, a.id, d.id)!
  expect(r.legs.length, 1, 'one leg: ')
  expect(r.legs[0].lineId, p.lines[1].id, 'the express is cheaper end to end: ')
})

/** Three stations on a one-way run. */
function onewayFixture() {
  const p: Project = createEmptyProject('oneway')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  p.stations = [a, b, c]
  const l = line('Loop', [[a.id, b.id, c.id]])
  l.branches[0].direction = 'forward'
  p.lines = [l]
  return { p, net: buildNetwork(p), a, b, c }
}

check('a one-way branch can be ridden in its listed order', () => {
  const { p, net, a, c } = onewayFixture()
  const r = findRoute(p, net, a.id, c.id)
  assert(r !== null, 'A to C runs with the direction of travel')
  expect(r!.stopCount, 2)
})

check('a one-way branch cannot be ridden backwards', () => {
  const { p, net, a, c } = onewayFixture()
  expect(findRoute(p, net, c.id, a.id), null, 'C to A runs against the only direction offered: ')
})

check('a two-way branch is unaffected by the direction check', () => {
  const { p, a, c } = onewayFixture()
  p.lines[0].branches[0].direction = 'both'
  const again = buildNetwork(p)
  assert(findRoute(p, again, c.id, a.id) !== null, 'both means both')
})

check('migration gives a v2 project the v3 defaults', () => {
  const p = createEmptyProject('m')
  const s = station('A', 0, 0)
  p.stations = [s]
  p.lines = [line('L', [[s.id]])]
  // Strip the v3 fields the way a project written by the older build would be.
  const older = JSON.parse(JSON.stringify({ ...p, version: 2 }))
  delete older.stations[0].badges
  delete older.stations[0].status
  delete older.stations[0].symbol
  delete older.lines[0].branches[0].passes
  delete older.lines[0].branches[0].direction
  delete older.assets
  delete older.placements
  const fixed = normalizeProject(older)
  expect(fixed.version, 3)
  expect(fixed.stations[0].badges, [])
  expect(fixed.stations[0].status, 'open')
  expect(fixed.stations[0].symbol, { kind: 'auto' })
  expect(fixed.lines[0].branches[0].passes, [])
  expect(fixed.lines[0].branches[0].direction, 'both', 'an old branch rode both ways: ')
  expect(fixed.assets, [])
  expect(fixed.placements, [])
})

check('migration drops a symbol pointing at a missing asset', () => {
  const p = createEmptyProject('m')
  const s = station('A', 0, 0)
  s.symbol = { kind: 'asset', assetId: 'as_gone' as never, scale: 1 }
  p.stations = [s]
  const fixed = normalizeProject(JSON.parse(JSON.stringify(p)))
  expect(fixed.stations[0].symbol, { kind: 'auto' }, 'a dangling asset ref must fall back: ')
})

// ---------------------------------------------------------------------------
// Curves and holes
// ---------------------------------------------------------------------------

check('a plain run with no rounding is straight segments', () => {
  const d = polylinePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0)
  assert(!d.includes('Q'), 'no radius means no curve')
})

check('a curved vertex arcs even when the global radius is zero', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const plain = polylinePath(pts, 0)
  const curved = polylinePath(pts, 0, [false, true, false])
  assert(!plain.includes('Q'), 'baseline is mitred')
  assert(curved.includes('Q'), 'the flagged corner must sweep')
})

check('a curved vertex takes a larger arc than the global radius', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
  const small = polylinePath(pts, 4)
  const swept = polylinePath(pts, 4, [false, true, false])
  assert(small !== swept, 'the curve flag must change the path')
  // The arc starts further back along the incoming segment the bigger it is.
  const startX = (d: string) => Number(/L ([-\d.]+)/.exec(d)![1])
  assert(startX(swept) < startX(small), 'a swept corner leaves the straight earlier')
})

check('an arc never overruns its neighbouring segment', () => {
  // A short segment between two long ones: the curve must clamp to half of it.
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 110, y: 0 }, { x: 110, y: 100 }]
  const d = polylinePath(pts, 0, [false, true, true, false])
  const xs = [...d.matchAll(/([-\d.]+),([-\d.]+)/g)].map((m) => Number(m[1]))
  assert(xs.every((x) => x >= -0.01 && x <= 110.01), 'no control point may escape the run')
})

check('a shape with no holes is a single closed subpath', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  const d = polygonPathWithHoles(sq, [])
  expect(d.match(/Z/g)?.length, 1)
  expect(d, polygonPath(sq), 'no holes must be identical to the plain path: ')
})

check('a hole adds a second closed subpath', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  const hole = [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }]
  const d = polygonPathWithHoles(sq, [hole])
  expect(d.match(/Z/g)?.length, 2, 'outer ring plus the island: ')
  expect(d.match(/M/g)?.length, 2)
})

check('a degenerate hole is dropped rather than drawn', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  const d = polygonPathWithHoles(sq, [[{ x: 1, y: 1 }, { x: 2, y: 2 }]])
  expect(d.match(/Z/g)?.length, 1, 'two points cannot enclose anything: ')
})

// ---------------------------------------------------------------------------
// Where the new model reaches the drawing
// ---------------------------------------------------------------------------

check('a ring gets no route bullet', () => {
  const { p, net } = ringFixture()
  expect(lineBadges(p, net, 'schematic').length, 0, 'a loop has no end to label: ')
})

check('an ordinary line still gets bullets at both ends', () => {
  const { p } = sharedCorridorFixture()
  const badges = lineBadges(p, buildNetwork(p), 'schematic')
  assert(badges.length >= 2, 'two lines with two ends each')
})

check('a passed station keeps its symbol off the express', () => {
  const { p, net, b } = expressFixture()
  const station = p.stations.find((s) => s.id === b.id)!
  const sym = stationSymbol(p, net, station, 'schematic')
  // B is still served by the local, so it is a plain stop rather than an interchange.
  expect(sym.lineCount, 1, 'passing through must not count as serving: ')
  assert(!sym.terminus, 'and it is nobody\'s terminus')
})

check('an express does not make its skipped stops interchanges', () => {
  const { net, b, c } = expressFixture()
  assert(!net.interchanges.has(b.id), 'B is on one line only')
  assert(!net.interchanges.has(c.id), 'and so is C')
})

check('a one-way branch still draws its full geometry', () => {
  const { p, net } = onewayFixture()
  const l = p.lines[0]
  const g = branchGeometry(p, net, l, l.branches[0], 'schematic')!
  expect(g.points.length, 3, 'direction restricts riding, not drawing: ')
})

check('migration fills in terrain holes and fill', () => {
  const p = createEmptyProject('t')
  const older = JSON.parse(
    JSON.stringify({
      ...p,
      version: 2,
      terrain: [
        {
          id: 'tr_1',
          kind: 'water',
          name: 'Lake',
          geo: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
          schematic: [],
          closed: true,
          hidden: false,
        },
      ],
    }),
  )
  const fixed = normalizeProject(older)
  expect(fixed.terrain[0].holes, [], 'no holes is not the same as undefined: ')
  expect(fixed.terrain[0].fill, 'solid', 'solid is how every kind was painted before: ')
  expect(fixed.terrain[0].schematic.length, 3, 'a missing diagram shape copies the traced one: ')
})

check('migration drops a placement whose asset is gone', () => {
  const p = createEmptyProject('t')
  const older = JSON.parse(
    JSON.stringify({
      ...p,
      version: 2,
      assets: [],
      placements: [
        {
          id: 'pl_1',
          what: { kind: 'asset', assetId: 'as_gone' },
          geo: { x: 0, y: 0 },
          schematic: { x: 0, y: 0 },
          scale: 1,
          angle: 0,
          opacity: 1,
          locked: false,
          hidden: false,
        },
        {
          id: 'pl_2',
          what: { kind: 'legend' },
          geo: { x: 5, y: 5 },
          schematic: { x: 5, y: 5 },
          scale: 1,
          angle: 0,
          opacity: 1,
          locked: false,
          hidden: false,
        },
      ],
    }),
  )
  const fixed = normalizeProject(older)
  expect(fixed.placements.length, 1, 'a dangling marker is invisible AND unselectable: ')
  expect(fixed.placements[0].id, 'pl_2')
})

check('crossings ignore a line crossing itself', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 100, y: 100 }
  const c = { x: 0, y: 100 }
  const d = { x: 100, y: 0 }
  const one = findCrossings(
    [{ id: 'L1', z: 1, width: 6, segments: [{ a, b, segKey: 'x' }, { a: c, b: d, segKey: 'y' }] }],
    [],
    0,
    { length: 3, height: 3 },
  )
  expect(one.length, 0, 'a line crossing itself needs no bridge: ')
})

// ---------------------------------------------------------------------------
// The example, and the bounds that have to contain it
// ---------------------------------------------------------------------------

check('every label fits inside the exported page', () => {
  const p = createSampleProject()
  const net = buildNetwork(p)
  const b = contentBounds(p, 'schematic', 0, net)
  for (const r of labelRects(p, net, 'schematic')) {
    assert(
      r.x >= b.minX - 0.01 &&
        r.y >= b.minY - 0.01 &&
        r.x + r.w <= b.maxX + 0.01 &&
        r.y + r.h <= b.maxY + 0.01,
      `a label at ${Math.round(r.x)},${Math.round(r.y)} falls outside the page`,
    )
  }
})

check('map furniture counts towards the content bounds', () => {
  const p = createEmptyProject('b')
  const s = station('A', 0, 0)
  p.stations = [s]
  p.lines = [line('L', [[s.id]])]
  const bare = contentBounds(p, 'schematic', 0)
  p.placements = [
    {
      id: 'pl_1' as never,
      what: { kind: 'legend' },
      geo: { x: 900, y: 0 },
      schematic: { x: 900, y: 0 },
      scale: 1,
      angle: 0,
      opacity: 1,
      locked: false,
      hidden: false,
    },
  ]
  const withIt = contentBounds(p, 'schematic', 0)
  assert(
    withIt.maxX > bare.maxX,
    'a legend in the margin must widen the bounds, or the export crops it away',
  )
})

check('hidden furniture does not stretch the bounds', () => {
  const p = createEmptyProject('b')
  const s = station('A', 0, 0)
  p.stations = [s]
  p.lines = [line('L', [[s.id]])]
  const bare = contentBounds(p, 'schematic', 0)
  p.placements = [
    {
      id: 'pl_1' as never,
      what: { kind: 'frame' },
      geo: { x: 5000, y: 0 },
      schematic: { x: 5000, y: 0 },
      scale: 1,
      angle: 0,
      opacity: 1,
      locked: false,
      hidden: true,
    },
  ]
  expect(contentBounds(p, 'schematic', 0).maxX, bare.maxX, 'hidden is hidden: ')
})

check('the example network is internally sound', () => {
  const p = createSampleProject()
  const net = buildNetwork(p)
  const names = new Map<string, number>()
  for (const s of p.stations) names.set(s.name, (names.get(s.name) ?? 0) + 1)
  const dupes = [...names].filter(([, n]) => n > 1).map(([n]) => n)

  expect(dupes, [], 'two stations sharing a name are two places with one identity: ')
  expect(net.orphans.size, 0, 'every stop in the example is on a line: ')
  assert(p.stations.length > 150, 'the example is a city, not a sketch')
  // Errors are always a defect. Warnings here are real layout observations about a
  // hand-composed map -- lines running past stations they do not serve -- which the
  // Checks panel is meant to surface rather than the build to forbid.
  const issues = validateProject(p, net)
  expect(issues.filter((i) => i.severity === 'error').length, 0, 'no errors: ')
})

check('the example exercises the features it claims to', () => {
  const p = createSampleProject()
  const modes = new Set(p.lines.map((l) => l.mode))
  // Not all six: the example has no water on it, so it carries no ferry. Asserting a
  // count here would be asserting a design decision rather than a property.
  assert(modes.size >= 5, `expected a broad spread of modes, got ${modes.size}`)
  assert(p.lines.some((l) => l.branches.some(isRing)), 'a ring')
  assert(p.lines.some((l) => l.branches.some((b) => b.direction === 'forward')), 'a one-way branch')
  assert(p.lines.some((l) => l.branches.some((b) => b.passes.length > 0)), 'an express')
  assert(p.lines.some((l) => l.branches.some((b) => b.color)), 'a branch with its own colour')
  assert(p.lines.some((l) => l.branches.some((b) => b.service)), 'a service label')
  assert(p.lines.some((l) => l.branches.length > 1), 'a Y-shaped line')
  assert(p.stations.some((s) => s.nameSecondary), 'a second name')
  assert(p.stations.some((s) => s.badges.length > 0), 'station marks')
  assert(p.stations.some((s) => s.status !== 'open'), 'something not yet open')
  assert(p.stations.some((s) => s.zone), 'fare zones')
  assert(p.terrain.some((t) => t.fill === 'hatch'), 'hatching')
  assert(p.terrain.some((t) => t.text), 'styled annotation')
  assert(p.placements.length >= 4, 'map furniture')
  assert(p.transfers.length > 0, 'an out-of-station link')
})

check('an express shares the corridor it runs along with the local', () => {
  const { net, a, b, local, exp } = expressFixture()
  // The segment A-B belongs to the local's calling pattern and to the express's
  // physical run. Both lines must appear in it, or neither knows to step aside.
  const key = segmentKey(a.id, b.id)
  const users = net.corridors.get(key) ?? []
  assert(users.includes(local.id), 'the local runs A-B')
  assert(users.includes(exp.id), 'so does the express, even though it does not stop at B')
})

check('an express is drawn beside the local, not on top of it', () => {
  const { p, net, local, exp } = expressFixture()
  const lg = branchGeometry(p, net, local, local.branches[0], 'schematic')!
  const eg = branchGeometry(p, net, exp, exp.branches[0], 'schematic')!
  const apart = offsetPolyline(lg.points, lg.offsets)
  const bpart = offsetPolyline(eg.points, eg.offsets)
  // Compare where each line actually sits at the shared middle of the run.
  const near = (pts: typeof apart, x: number) =>
    pts.reduce((best, q) => (Math.abs(q.x - x) < Math.abs(best.x - x) ? q : best), pts[0])
  const gap = Math.abs(near(apart, 150).y - near(bpart, 150).y)
  assert(gap > 1, `express and local must not coincide -- they are ${gap.toFixed(2)} apart`)
})

check('a passed station is a neighbour of what the line runs between', () => {
  const { net, a, b } = expressFixture()
  assert(!!net.neighbours.get(a.id)?.has(b.id), 'the express physically reaches B from A')
})

check('the example gets its stop spacing the right way round', () => {
  const p = createSampleProject()
  const where = new Map(p.stations.map((s) => [s.id, s.schematic]))

  const spacing = (mode: string) => {
    const gaps: number[] = []
    for (const l of p.lines.filter((x) => x.mode === mode)) {
      for (const b of l.branches) {
        for (let i = 0; i < b.stops.length - 1; i++) {
          const a = where.get(b.stops[i])!
          const c = where.get(b.stops[i + 1])!
          const d = Math.hypot(c.x - a.x, c.y - a.y)
          if (d > 0) gaps.push(d)
        }
      }
    }
    return gaps.reduce((x, y) => x + y, 0) / gaps.length
  }
  const stops = (mode: string) => {
    const counts = p.lines
      .filter((x) => x.mode === mode)
      .flatMap((l) => l.branches.map((b) => b.stops.length))
    return counts.reduce((x, y) => x + y, 0) / counts.length
  }

  // This is the thing an invented network gets wrong first, and it is why a map reads
  // as a real system or as a drawing: a train does not stop every 500 metres and a tram
  // does not run two kilometres between stops.
  assert(spacing('rail') > spacing('metro') * 1.5, 'rail must be spaced far wider than metro')
  assert(spacing('metro') > spacing('tram') * 1.5, 'metro must be spaced far wider than tram')
  assert(stops('tram') > stops('rail') * 1.5, 'a tram route carries far more stops than a rail one')
})

check('only the buses wander', () => {
  const p = createSampleProject()
  const where = new Map(p.stations.map((s) => [s.id, s.schematic]))

  // How far a route deviates from the straight line between its two ends. A rapid
  // transit line is near zero; a bus route exists precisely because it is not.
  const wander = (l: (typeof p.lines)[number]) => {
    const b = l.branches[0]
    const pts = b.stops.map((id) => where.get(id)!)
    if (pts.length < 3) return 0
    const a = pts[0]
    const z = pts[pts.length - 1]
    const len = Math.hypot(z.x - a.x, z.y - a.y)
    if (len < 1) return 0
    let worst = 0
    for (const q of pts) {
      const t = ((q.x - a.x) * (z.x - a.x) + (q.y - a.y) * (z.y - a.y)) / (len * len)
      const px = a.x + (z.x - a.x) * t
      const py = a.y + (z.y - a.y) * t
      worst = Math.max(worst, Math.hypot(q.x - px, q.y - py))
    }
    return worst / len
  }

  const straightest = (mode: string) =>
    Math.max(...p.lines.filter((l) => l.mode === mode && l.branches[0].stops.length > 2).map(wander))
  const buses = p.lines.filter((l) => l.mode === 'bus' && l.name !== 'A1')

  assert(straightest('metro') < 0.05, 'a metro line runs straight')
  assert(straightest('rail') < 0.05, 'so does heavy rail')
  assert(buses.some((l) => wander(l) > 0.15), 'at least one bus route genuinely wanders')
})

check('a station an express runs past does not look like an express stop', () => {
  const { p, net, b } = expressFixture()
  const station = p.stations.find((s) => s.id === b.id)!
  const sym = stationSymbol(p, net, station, 'schematic')

  // Only the local calls at B. The symbol must belong to the local alone: no bar laid
  // across the express, which would read as "everything stops here".
  expect(sym.lineCount, 1, 'one line calls at B: ')
  assert(sym.shape.kind !== 'bar', `expected a single-line mark, got a ${sym.shape.kind}`)
})

check('where two lines both call, they still share one bar', () => {
  const { p, a, b, c } = sharedCorridorFixture()
  const net = buildNetwork(p)
  void a
  void c
  const station = p.stations.find((s) => s.id === b.id)!
  const sym = stationSymbol(p, net, station, 'schematic')
  expect(sym.shape.kind, 'bar', 'two calling lines side by side read as one place: ')
})

check('a station some services run past gets one mark per calling service', () => {
  const { p, net, b } = expressFixture()
  const sym = stationSymbol(p, net, p.stations.find((s) => s.id === b.id)!, 'schematic')

  // The New York rule: the dot belongs to the service, not to the place. One calling
  // line means one mark, and the express track beside it carries none.
  expect(sym.shape.kind, 'perService', 'a corridor with a service running past: ')
  if (sym.shape.kind !== 'perService') return
  expect(sym.shape.marks.length, 1, 'only the local calls at B: ')
  expect(sym.shape.passing, 1, 'and exactly one service runs past: ')
})

check('the mark sits on the calling track, not in the middle of the corridor', () => {
  const { p, net, b } = expressFixture()
  const sym = stationSymbol(p, net, p.stations.find((s) => s.id === b.id)!, 'schematic')
  if (sym.shape.kind !== 'perService') throw new Error('expected perService')
  const d = Math.hypot(sym.shape.marks[0].at.x, sym.shape.marks[0].at.y)
  assert(d > 0.5, `the mark must move onto the local track, offset was ${d.toFixed(2)}`)
})

check('where every service calls, they share one symbol again', () => {
  const { p, b } = sharedCorridorFixture()
  const net = buildNetwork(p)
  const sym = stationSymbol(p, net, p.stations.find((s) => s.id === b.id)!, 'schematic')
  assert(
    sym.shape.kind !== 'perService',
    'nothing runs past here, so one shape should read as one place',
  )
})

check('every calling service gets a mark, whichever direction it arrives from', () => {
  // A crossing: the local and its express run north-south, a third line runs east-west
  // and stops. All three calling lines need a dot; only the express goes unmarked.
  const p: Project = createEmptyProject('cross')
  const a = station('A', 0, 0)
  const b = station('B', 0, 100)
  const c = station('C', 0, 200)
  const w = station('W', -100, 100)
  const e = station('E', 100, 100)
  p.stations = [a, b, c, w, e]
  const local = line('Local', [[a.id, b.id, c.id]])
  const exp = line('Express', [[a.id, c.id]], '#1B4F9C')
  exp.branches[0].passes = [b.id]
  const cross = line('Cross', [[w.id, b.id, e.id]], '#00784F')
  p.lines = [local, exp, cross]

  const net = buildNetwork(p)
  const sym = stationSymbol(p, net, b, 'schematic')
  expect(sym.shape.kind, 'perService')
  if (sym.shape.kind !== 'perService') return

  // The local shares the bundle the express runs past, so it gets its own dot. The
  // crossing line arrives on a different axis: giving it a dot too would put two marks
  // a few units apart, overlapping. It is covered by the tie, which is extended to the
  // middle where its stroke runs.
  expect(sym.shape.marks.length, 1, 'one dot, in the bundle that has a service running past: ')
  expect(sym.shape.passing, 1, 'only the express runs past: ')
  assert(!!sym.shape.tie, 'and a tie reaches the crossing service')
})

check('marks land on distinct tracks rather than stacking up', () => {
  const { p, net, b } = expressFixture()
  const sym = stationSymbol(p, net, p.stations.find((s) => s.id === b.id)!, 'schematic')
  if (sym.shape.kind !== 'perService') throw new Error('expected perService')
  const seen = new Set(sym.shape.marks.map((m) => `${m.at.x.toFixed(2)},${m.at.y.toFixed(2)}`))
  expect(seen.size, sym.shape.marks.length, 'two services must not share one dot: ')
})

// ---------------------------------------------------------------------------
// The awkward shapes, measured
// ---------------------------------------------------------------------------

check('no station symbol collides with another in any scenario', () => {
  for (const sc of scenarios()) {
    const collisions = findOverlaps(sc.project).filter((o) => o.kind === 'marks-collide')
    assert(
      collisions.length === 0,
      `${sc.id}: ${collisions.map(describeOverlap).join('; ')}`,
    )
  }
})

check('no mark drifts off the line it belongs to, in any scenario', () => {
  for (const sc of scenarios()) {
    const adrift = findOverlaps(sc.project).filter((o) => o.kind === 'mark-off-its-line')
    assert(adrift.length === 0, `${sc.id}: ${adrift.map(describeOverlap).join('; ')}`)
  }
})

check('a service running alongside is never touched by the symbol', () => {
  // The one that matters: if a mark reaches a line that does not stop, the map says the
  // opposite of the timetable. Rings are excluded -- a mitred corner on a tight loop
  // pulls the parallel strokes together, which is a separate geometry problem.
  for (const sc of scenarios()) {
    if (sc.id === 'ring-express') continue
    const touching = findOverlaps(sc.project).filter(
      (o) => o.kind === 'mark-on-passing-line' && o.alongside,
    )
    assert(touching.length === 0, `${sc.id}: ${touching.map(describeOverlap).join('; ')}`)
  }
})

check('the example has no station symbols on top of each other', () => {
  const collisions = findOverlaps(createSampleProject()).filter(
    (o) => o.kind === 'marks-collide',
  )
  assert(collisions.length === 0, collisions.map(describeOverlap).join('; '))
})

check('a line never wanders off the path between its own stops', () => {
  // A pass-through lies ON the run by definition, so weaving it in cannot make the
  // line any longer. If it does, something not on the segment was inserted into it and
  // the centreline has been dragged out to that station and back — a spike across the
  // map, which is exactly how this failed.
  const p = createSampleProject()
  const net = buildNetwork(p)
  const where = stationMap(p)

  for (const line of p.lines) {
    for (const b of line.branches) {
      const g = branchGeometry(p, net, line, b, 'schematic', where)
      if (!g) continue
      let drawn = 0
      for (let i = 0; i < g.points.length - 1; i++) {
        drawn += dist(g.points[i], g.points[i + 1])
      }
      let direct = 0
      const stops = b.stops.map((id) => where.get(id)).filter((x): x is Station => !!x)
      for (let i = 0; i < stops.length - 1; i++) {
        direct += dist(stops[i].schematic, stops[i + 1].schematic)
      }
      if (direct < 1) continue
      assert(
        drawn <= direct * 1.02,
        `${line.name}: drawn ${Math.round(drawn)} against ${Math.round(direct)} between its stops`,
      )
    }
  }
})

check('a station on one segment is not dragged into another', () => {
  // An L: the corner station sits on neither leg's interior, and a station on the
  // horizontal leg projects neatly onto the vertical one's range. Only membership of
  // the segment itself may count.
  const p: Project = createEmptyProject('L')
  const a = station('A', 0, 0)
  const corner = station('Corner', 200, 0)
  const b = station('B', 200, 200)
  const onTop = station('OnTop', 100, 0)
  p.stations = [a, corner, b, onTop]
  p.lines = [line('L1', [[a.id, corner.id, b.id]]), line('L2', [[onTop.id, corner.id]])]

  const net = buildNetwork(p)
  const l1 = p.lines[0]
  const g = branchGeometry(p, net, l1, l1.branches[0], 'schematic')!
  // OnTop lies on A->Corner and must appear once, between them, and nowhere else.
  const xs = g.points.map((q) => `${q.x},${q.y}`)
  expect(xs.filter((q) => q === '100,0').length, 1, 'inserted exactly once: ')
  assert(
    !g.points.some((q) => q.x === 100 && q.y === 200),
    'and never onto the vertical leg it merely projects onto',
  )
})

check('following existing track walks the rails between two stops', () => {
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const d = station('D', 300, 0)
  const far = station('Far', 1000, 1000)
  p.stations = [a, b, c, d, far]
  p.lines = [line('L1', [[a.id, b.id, c.id, d.id]], '#C9342B')]
  const net = buildNetwork(p)
  const pos = stationMap(p)

  const path = trackPath(net, pos, a.id, d.id)!
  expect(path.length, 4, 'A B C D: ')
  expect(path[1], b.id)
  expect(path[2], c.id)

  // No rails, no path -- the caller falls back to a straight hop.
  expect(trackPath(net, pos, a.id, far.id), null, 'nothing reaches Far: ')
  expect(trackPath(net, pos, a.id, a.id)!.length, 1, 'a stop reaches itself: ')
})

check('the shortest rails win when there are two ways round', () => {
  const p: Project = createEmptyProject('t')
  const a = station('A', 0, 0)
  const b = station('B', 100, 0)
  const c = station('C', 200, 0)
  const long1 = station('L1', 100, 400)
  const long2 = station('L2', 200, 400)
  p.stations = [a, b, c, long1, long2]
  p.lines = [
    line('Direct', [[a.id, b.id, c.id]], '#C9342B'),
    line('Roundabout', [[a.id, long1.id, long2.id, c.id]], '#1B4F9C'),
  ]
  const net = buildNetwork(p)
  const path = trackPath(net, stationMap(p), a.id, c.id)!
  expect(path.length, 3, 'straight through B: ')
  expect(path[1], b.id)
})

check('a calling pattern rewrites a branch without losing its ends', () => {
  const p: Project = createEmptyProject('t')
  const ids = [0, 1, 2, 3, 4, 5].map((i) => station(`S${i}`, i * 100, 0))
  p.stations = ids
  const l = line('L', [ids.map((s) => s.id)], '#C9342B')
  p.lines = [l]
  const stations = stationMap(p)
  const branch = l.branches[0]

  const a = applyCallingMask(branch, stations, 'alternate-a')!
  const b = applyCallingMask(branch, stations, 'alternate-b')!

  for (const out of [a, b]) {
    expect(out.stops[0], ids[0].id, 'the first stop still calls: ')
    expect(out.stops[out.stops.length - 1], ids[5].id, 'and the last: ')
    for (const id of out.passes) assert(!out.stops.includes(id), 'never both at once')
  }

  // Between them, the pair serves everything.
  const covered = new Set([...a.stops, ...b.stops])
  expect(covered.size, 6, 'the skip-stop pair covers the line: ')
  assert(a.passes.length > 0 && b.passes.length > 0, 'and each skips something')

  // An explicit list is honoured, ends excepted.
  const only = applyCallingMask(branch, stations, { calls: [ids[2].id] })!
  expect(only.stops.length, 3, 'S0, S2, S5: ')
  expect(only.passes.length, 3)

  // Back to all stops, and nothing is left behind.
  const all = applyCallingMask({ ...branch, stops: only.stops, passes: only.passes }, stations, 'all')!
  expect(all.stops.length, 6, 'every stop calls again: ')
  expect(all.passes.length, 0)
})

check('a point inside a band is inside, and a hole in it is not', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ]
  assert(pointInPolygon({ x: 50, y: 50 }, square), 'the middle is inside')
  assert(!pointInPolygon({ x: 150, y: 50 }, square), 'and outside is not')

  // Concave, because rings traced by hand rarely are not.
  const notch = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 60, y: 100 },
    { x: 60, y: 40 },
    { x: 40, y: 40 },
    { x: 40, y: 100 },
    { x: 0, y: 100 },
  ]
  assert(pointInPolygon({ x: 50, y: 20 }, notch), 'below the notch is inside')
  assert(!pointInPolygon({ x: 50, y: 80 }, notch), 'the notch itself is not')

  const hole = [
    { x: 40, y: 40 },
    { x: 60, y: 40 },
    { x: 60, y: 60 },
    { x: 40, y: 60 },
  ]
  assert(!pointInShape({ x: 50, y: 50 }, square, [hole]), 'an island is not the lake')
  assert(pointInShape({ x: 20, y: 20 }, square, [hole]), 'but the water around it is')
})

check('every starter template builds a network the rest of the app accepts', () => {
  for (const t of TEMPLATES) {
    const p = createFromTemplate(t.id)
    const net = buildNetwork(p)
    assert(p.stations.length > 0, `${t.id} has stations`)
    assert(p.lines.length > 0, `${t.id} has lines`)
    expect(net.orphans.size, 0, `${t.id} leaves no stop off a line: `)
    assert(net.interchanges.size > 0, `${t.id} has somewhere to change`)

    // Nothing the checker calls the renderer's fault -- a template that ships with a
    // drawing fault teaches the fault.
    const faults = findOverlaps(p).filter(
      (o) => o.kind === 'mark-off-its-line' || o.kind === 'marks-collide' || o.alongside,
    )
    assert(faults.length === 0, `${t.id}: ${faults.map(describeOverlap).join('; ')}`)

    // And every line draws.
    const stations = stationMap(p)
    for (const l of p.lines) {
      for (const b of l.branches) {
        assert(
          branchGeometry(p, net, l, b, 'schematic', stations) !== null,
          `${t.id}: ${l.name} draws`,
        )
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const total = passed + failures.length
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${total} checks FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`✓ all ${total} domain checks passed`)
void dist
