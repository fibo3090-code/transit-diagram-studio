/**
 * Domain tests.
 *
 * The domain layer is pure — no DOM, no framework — so it can be checked directly.
 * These cover the parts where a silent wrong answer would be hard to notice by eye:
 * corridor offset signs, index stability through offsetting, and the snap engine.
 *
 * Run with `npm test`.
 */

import { createEmptyProject, nextUnusedColor } from './defaults'
import {
  dist,
  octilinearizeRun,
  offsetPolyline,
  simplify,
  snapDir45,
} from './geometry'
import { newBranchId, newLineId, newStationId } from './ids'
import { placeLabels } from './labels'
import { applyCsv, parseCsv } from './csv'
import {
  branchGeometry,
  buildNetwork,
  isForward,
  segmentKey,
} from './network'
import { findCrossings } from './crossings'
import { findRoute } from './routing'
import { newTransferId } from './ids'
import { snapPoint } from './snapping'
import { stationLevels, stationSymbol } from './symbols'
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
  return {
    id: newStationId(),
    name,
    geo: { x, y },
    schematic: { x, y },
    modes: [],
    label: { anchor: 'auto', offset: { x: 0, y: 0 }, pinned: false, angle: 0, hidden: false },
  }
}

function line(name: string, branches: StationId[][], color = '#C9342B'): Line {
  return {
    id: newLineId(),
    name,
    mode: 'metro',
    color,
    branches: branches.map((stops): Branch => ({ id: newBranchId(), stops })),
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
  const { p, b, c } = sharedCorridorFixture()
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
  const { p, b, c } = sharedCorridorFixture()
  const key = segmentKey(b.id, c.id)
  const [l1, l2] = p.lines
  p.corridorOrder[key] = [l2.id, l1.id]
  const net = buildNetwork(p)
  near(net.offsets.get(key)!.get(l2.id)!, -5, 1e-9, 'overridden first: ')
  near(net.offsets.get(key)!.get(l1.id)!, 5, 1e-9, 'overridden second: ')
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
  const anchor = anchors.get(b.id)
  assert(
    anchor === 'n' || anchor === 's' || anchor === 'ne' || anchor === 'nw' ||
      anchor === 'se' || anchor === 'sw',
    `a mid-corridor label should move off the track, got ${anchor}`,
  )
})

check('a pinned label keeps its anchor', () => {
  const { p } = sharedCorridorFixture()
  p.stations[0].label = { ...p.stations[0].label, anchor: 'sw', pinned: true }
  const net = buildNetwork(p)
  expect(placeLabels(p, net, 'schematic').get(p.stations[0].id), 'sw')
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

check('a crossing at a station is a junction, not an overpass', () => {
  const cs = findCrossings(
    [
      { id: 'a', z: 0, width: 8, segments: H(0) },
      { id: 'b', z: 1, width: 8, segments: V(0) },
    ],
    [{ x: 0, y: 0 }],
    12,
    { length: 3, height: 3 },
  )
  expect(cs.length, 0)
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
