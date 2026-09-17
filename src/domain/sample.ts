/**
 * The example network.
 *
 * A blank canvas is the worst possible first screen for a tool like this: you cannot
 * tell what a finished map is supposed to look like, so you cannot tell what any of the
 * controls are for. Opening a finished network first answers both questions in a second,
 * and gives you something safe to pull apart.
 *
 * ## Why it is a table rather than a generator
 *
 * An earlier version computed this network from corridor definitions. It produced the
 * right structure and the wrong map: laying out a transit diagram is a design job, and
 * the placement decisions that make one readable — which line bends where, which label
 * goes above rather than below, where to leave air — do not survive being reduced to
 * a rule. The layout below was composed by hand in the editor and exported, so what
 * ships is what was actually drawn.
 *
 * The stop spacing it keeps is the part that makes a network read as a system rather
 * than a drawing, and it is the first thing an invented map gets wrong:
 *
 *   heavy rail   widest spacing, fewest stops, out to the edges of the map
 *   metro        about half that, straight, through the middle
 *   tram         tightest spacing, most stops, inner city only
 *   bus          tight spacing AND a wandering route
 *   cable        one climb
 *
 * Between them these lines use five modes, a Y-shaped branch, a ring with no terminus,
 * an express that runs through the stations it skips, a one-way loop, branch colours and
 * service labels, shared corridors with parallel offsets, bar interchanges,
 * out-of-station links, fare zones, second names, accessibility marks, stations not yet
 * open, terrain with hatching and stipple, styled annotations, and a legend that derives
 * itself from the lines.
 */

import {
  newBranchId,
  newLineId,
  newPlacementId,
  newProjectId,
  newStationId,
  newTerrainId,
  newTransferId,
} from './ids'
import { createEmptyProject, makeBranch, makeStation, makeTerrain } from './defaults'
import type {
  Branch,
  BranchDirection,
  Line,
  Placement,
  Project,
  Station,
  StationId,
  Terrain,
  TerrainKind,
} from './types'

/** `[name, diagram x, diagram y, map x, map y, fare zone, anything else]` */
type Row = [string, number, number, number, number, string, Partial<Station>?]

const STATIONS: Row[] = [
  ["Aldbury North", 1260, 90, 1337, 128, "3", {"badges": ["rail", "park-ride", "step-free"]}],
  ["Kestrel Hill", 1260, 450, 1223, 482, "1"],
  ["Aldbury Central", 1260, 810, 1271, 828, "1", {"badges": ["rail", "step-free", "bus"], "nameSecondary": "Canol Aldbury"}],
  ["Sallowfield", 1260, 1170, 1238, 1200, "1"],
  ["Aldbury South", 1260, 1530, 1251, 1505, "3", {"badges": ["rail", "park-ride"]}],
  ["Aldbury West", 180, 810, 203, 887, "3", {"badges": ["rail", "park-ride"]}],
  ["Marlbrook", 540, 810, 480, 810, "2"],
  ["Guild Square", 900, 810, 869, 815, "1"],
  ["Threadneedle", 1620, 810, 1628, 735, "1"],
  ["Havershall", 1980, 810, 2066, 771, "2"],
  ["Eastmarch", 2340, 810, 2399, 858, "3", {"badges": ["rail", "park-ride", "step-free"]}],
  ["Willowdene", 180, 1530, 122, 1532, "3"],
  ["Hedgerley", 540, 1530, 629, 1487, "3", {"badges": ["park-ride"]}],
  ["Lambourne", 900, 1530, 957, 1611, "3", {"status": "construction"}],
  ["Pickering", 1620, 1530, 1610, 1464, "3", {"status": "construction"}],
  ["Marchwood", 1980, 1530, 2057, 1563, "3", {"badges": ["park-ride"]}],
  ["Haverside", 2340, 1530, 2328, 1506, "3", {"badges": ["rail", "park-ride"]}],
  ["Carrickfell", 540, 90, 566, 108, "3"],
  ["Claverton", 720, 270, 689, 224, "2"],
  ["Elmswood", 900, 450, 947, 461, "1"],
  ["Cordwainer Lane", 1080, 630, 1068, 653, "1"],
  ["Bishopsgate", 1440, 990, 1469, 963, "1"],
  ["Candlewick", 1620, 1170, 1605, 1086, "1"],
  ["Verdant Way", 1800, 1350, 1734, 1308, "2"],
  ["Lowbank", 720, 1350, 690, 1304, "2"],
  ["Sedgeley", 900, 1170, 899, 1253, "1"],
  ["Amberley", 1080, 990, 1024, 1023, "1"],
  ["Kings Wharf", 1440, 630, 1379, 566, "1"],
  ["Ashcombe", 1620, 450, 1605, 411, "1"],
  ["Templeton", 1800, 270, 1887, 242, "2"],
  ["Ravensmoor", 1980, 90, 2021, 14, "3", {"badges": ["step-free"]}],
  ["Priorswood", 180, 450, 141, 513, "3"],
  ["Ulverton", 360, 450, 345, 392, "3"],
  ["Chandlers Gate", 540, 450, 486, 507, "2"],
  ["Pomeroy", 720, 450, 734, 504, "2"],
  ["Vestry Green", 1080, 450, 1167, 426, "1"],
  ["Cardingmill", 1440, 450, 1515, 383, "1"],
  ["Marlowe Street", 1800, 450, 1794, 512, "2"],
  ["Alderholt", 1980, 450, 2028, 482, "2"],
  ["Ferrers Green", 2160, 450, 2178, 401, "3"],
  ["Whitcombe", 2340, 450, 2418, 489, "3", {"badges": ["park-ride"]}],
  ["Harrowgate", 900, 90, 891, 81, "3"],
  ["Whitmoor", 900, 270, 861, 250, "2", {"label": {"anchor": "e", "offset": {"x": 23.649935340245634, "y": 18.011799713439927}, "pinned": true, "angle": 0, "hidden": false}}],
  ["Marston Gate", 900, 630, 935, 600, "1"],
  ["Foundry Row", 900, 990, 897, 896, "1"],
  ["Kilnmore", 900, 1350, 861, 1398, "2"],
  ["Thornleigh", 1620, 90, 1623, 162, "3"],
  ["Nettlebed", 1620, 270, 1556, 287, "2"],
  ["Peverel", 1620, 630, 1551, 680, "1"],
  ["Ludgershall", 1620, 990, 1584, 986, "1"],
  ["Ryehill", 1620, 1350, 1551, 1325, "2"],
  ["Almsbury", 540, 270, 596, 239, "2", {"badges": ["step-free"]}],
  ["Corbridge", 1080, 270, 1089, 242, "2"],
  ["Highgate Bar", 1260, 270, 1244, 188, "2"],
  ["Ashfield Gate", 1440, 270, 1508, 275, "2"],
  ["Pargeter Hill", 1980, 270, 1976, 287, "2"],
  ["Stainforth", 1980, 630, 1931, 713, "2"],
  ["Wrenbury", 1980, 990, 1946, 1023, "2"],
  ["Wolvercote", 1980, 1170, 1922, 1133, "2"],
  ["Tidewell", 1980, 1350, 1922, 1253, "2"],
  ["Cobbleworth", 1440, 1350, 1400.06, 1336, "2"],
  ["Longmarsh", 1260, 1350, 1286, 1286, "2"],
  ["Hattersley", 1080, 1350, 993, 1367, "2"],
  ["Turnstone", 540, 1350, 467, 1263, "2"],
  ["Dunmore", 540, 1170, 464, 1254, "2"],
  ["Quarry End", 540, 990, 558, 950, "2"],
  ["Tolliver", 540, 630, 511, 586, "2"],
  ["Barrowfield", 720, 630, 701, 701, "2"],
  ["Sculthorpe", 810, 630, 779, 614, "1"],
  ["Ash Hollow", 990, 630, 978.72, 600, "1"],
  ["Exchange", 1170, 630, 1122, 724, "1"],
  ["Saltmarket", 1260, 630, 1201, 682, "1"],
  ["Tanner Street", 1350, 630, 1286, 597, "1"],
  ["Marsh Lane", 1530, 630, 1475, 687, "1"],
  ["Crowmere", 1710, 630, 1727, 657, "1"],
  ["Alderholt Green", 1800, 630, 1737, 591, "2"],
  ["Cloister Walk", 1080, 360, 1126.69, 347.64, "2"],
  ["Blackfriars", 1080, 540, 1068, 512, "1"],
  ["Cranbourne", 1080, 720, 998, 735, "1"],
  ["Aldbury Guildhall", 1080, 810, 1122, 776, "1"],
  ["Southwark Row", 1080, 900, 1024, 920, "1"],
  ["Peartree", 1080, 1080, 1007, 1098, "1"],
  ["Oakhanger", 1080, 1170, 1040, 1211, "1"],
  ["Sallow Row", 1080, 1260, 1007, 1329, "2"],
  ["Pentland", 1440, 360, 1418, 276, "2"],
  ["Marlowe Gate", 1440, 540, 1418, 480, "1"],
  ["Eastgate", 1440, 720, 1379, 653, "1"],
  ["Isle of Gull", 1440, 810, 1430, 776, "1"],
  ["Bell Quay", 1440, 900, 1469, 887, "1"],
  ["Salthouse", 1440, 1080, 1446, 1048, "1"],
  ["Windlass", 1440, 1170, 1376, 1118, "1"],
  ["Trencher Lane", 1440, 1260, 1400.06, 1214.03, "2"],
  ["Barrowfield South", 720, 990, 689, 961, "2"],
  ["Priory Fields", 810, 990, 816.17, 1012, "1"],
  ["Ferngate", 990, 990, 978.72, 960.84, "1"],
  ["Bowyers Lea", 1170, 990, 1143, 989, "1"],
  ["Harbour Gate", 1260, 990, 1181, 1000, "1"],
  ["Netherwood", 1350, 990, 1271, 960, "1"],
  ["Sowerby", 1530, 990, 1529, 920, "1"],
  ["Willowdene Green", 1710, 990, 1668, 968, "1"],
  ["Alderholt South", 1800, 990, 1878, 1041, "2"],
  ["Westbourne", 720, 810, 644, 723, "2"],
  ["Tolliver Row", 810, 810, 750, 896, "1"],
  ["Lamplight Green", 990, 810, 957, 765, "1"],
  ["Cornmarket", 1170, 810, 1241, 798, "1"],
  ["Threadneedle Row", 1350, 810, 1356.3, 778.21, "1"],
  ["Marsh Gate", 1530, 810, 1544, 741, "1"],
  ["Crowmere Row", 1710, 810, 1749, 887, "1"],
  ["Alderholt West", 1800, 810, 1859, 855, "2"],
  ["Vestry Row", 1260, 360, 1208, 378, "2"],
  ["Cloister Green", 1260, 540, 1160.6, 578, "1"],
  ["Guildhall Yard", 1260, 720, 1179, 783, "1"],
  ["Bishopsgate Row", 1260, 900, 1176, 855, "1"],
  ["Peartree Row", 1260, 1080, 1181, 1109, "1"],
  ["Longmarsh Quay", 1260, 1260, 1322, 1253, "2"],
  ["Calder Bank", 360, 630, 371, 586, "3"],
  ["Dellbridge", 360, 720, 408, 678, "3"],
  ["Southmoor", 360, 810, 372, 735, "3"],
  ["Ninewells", 360, 900, 418.39, 810, "3"],
  ["Pyrton", 360, 990, 318, 962, "3"],
  ["Heathermoor", 360, 1080, 339.41, 1073.93, "3"],
  ["Sumpter Lane", 360, 1170, 402.48, 1137, "3"],
  ["Garrowby Road", 450, 1170, 402.48, 1212, "2"],
  ["Thistlewood Green", 630, 1170, 540, 1223, "2"],
  ["Ryehill Cross", 720, 1170, 701, 1098, "2"],
  ["Coalgate Road", 810, 1170, 816.17, 1128.06, "1"],
  ["Braybrooke Park", 900, 1260, 848, 1301, "2"],
  ["Beacon Halt", 2160, 270, 2238, 245, "3"],
  ["Cliff Halt", 2160, 360, 2130, 353, "3"],
  ["Airport Approach", 2160, 540, 2178, 471, "3"],
  ["Alderholt East", 2160, 630, 2201, 560, "3"],
  ["Stainforth Road", 2160, 720, 2201, 653, "3"],
  ["Wolvercote Hill", 2070, 720, 2123, 696, "2"],
  ["Tidewell Green", 1980, 720, 2024, 724, "2"],
  ["Marchwood Road", 1890, 720, 1947, 707, "2"],
  ["Haverside Lane", 1800, 720, 1736, 774, "2"],
  ["Sowerby Hill", 1800, 900, 1887, 920, "2"],
  ["Havershall Green", 1800, 1080, 1859, 1118, "2"],
  ["Crowmere Road", 1800, 1170, 1780, 1158, "2"],
  ["Pickering Road", 1890, 1170, 1749, 1223, "2"],
  ["Hollowmere", 270, 180, 320, 159, "3"],
  ["Fenwick Road", 270, 270, 318, 291, "3"],
  ["Stanmoor", 270, 360, 311, 354, "3"],
  ["Norbridge Lane", 270, 450, 239, 426, "3"],
  ["Calder Row", 270, 540, 281, 513, "3"],
  ["Priorswood Green", 270, 630, 311, 597, "3"],
  ["Carrickfell Road", 450, 630, 426.09, 617.09, "2"],
  ["Harrowgate Road", 630, 630, 583.28, 606.09, "2"],
  ["Whitmoor Lane", 630, 540, 648, 571, "2", {"label": {"anchor": "e", "offset": {"x": -11.416244829252037, "y": -19.305155552359565}, "pinned": true, "angle": 0, "hidden": false}}],
  ["Claverton Road", 630, 450, 663.86, 435.6, "2"],
  ["Almsbury Green", 630, 360, 620, 391.74, "2"],
  ["Pomeroy Road", 630, 270, 620, 315, "2"],
  ["Corbridge Lane", 630, 180, 668, 138, "3"],
  ["Elmswood Green", 720, 180, 734, 108, "3"],
  ["Aldbury Airport", 2340, 360, 2471.4, 435.6, "3", {"badges": ["airport", "rail", "step-free"], "nameSecondary": "Maes Awyr"}],
  ["Airport Cargo", 2340, 540, 2421, 560, "3"],
]

interface BranchSpec {
  stops: number[]
  passes?: number[]
  name?: string
  service?: string
  direction?: BranchDirection
  color?: string
}

const LINES: { name: string; mode: string; color: string; branches: BranchSpec[] }[] = [
  {
    name: "R1", mode: "rail", color: "#1277BA",
    branches: [
      { stops: [0, 1, 2, 3, 4], name: "all stations" },
    ],
  },
  {
    name: "R2", mode: "rail", color: "#C9342B",
    branches: [
      { stops: [0, 2, 4], passes: [1, 3], name: "express", service: "Peak only" },
    ],
  },
  {
    name: "R3", mode: "rail", color: "#1E2866",
    branches: [
      { stops: [5, 6, 7, 2, 8, 9, 10], name: "west coast" },
    ],
  },
  {
    name: "R4", mode: "rail", color: "#1E663B",
    branches: [
      { stops: [11, 12, 13, 4, 14, 15, 16], name: "southern orbital" },
    ],
  },
  {
    name: "M1", mode: "metro", color: "#990F0F",
    branches: [
      { stops: [17, 18, 19, 20, 2, 21, 22, 23, 15] },
    ],
  },
  {
    name: "M2", mode: "metro", color: "#2F459D",
    branches: [
      { stops: [12, 24, 25, 26, 2, 27, 28, 29, 30] },
    ],
  },
  {
    name: "M3", mode: "metro", color: "#0C790C",
    branches: [
      { stops: [31, 32, 33, 34, 19, 35, 1, 36, 28, 37, 38, 39, 40] },
    ],
  },
  {
    name: "M5", mode: "metro", color: "#8212BA",
    branches: [
      { stops: [41, 42, 19, 43, 7, 44, 25, 45, 13], name: "to Thistlewood" },
      { stops: [7, 6, 5], name: "to Aldbury West", color: "#99460F" },
    ],
  },
  {
    name: "M6", mode: "metro", color: "#BA1298",
    branches: [
      { stops: [46, 47, 28, 48, 8, 49, 22, 50, 14] },
    ],
  },
  {
    name: "C1", mode: "metro", color: "#827527",
    branches: [
      { stops: [51, 18, 42, 52, 53, 54, 47, 29, 55, 38, 56, 9, 57, 58, 59, 23, 50, 60, 61, 62, 45, 24, 63, 64, 65, 6, 66, 33, 51], name: "circle" },
    ],
  },
  {
    name: "T1", mode: "tram", color: "#278263",
    branches: [
      { stops: [67, 68, 43, 69, 20, 70, 71, 72, 27, 73, 48, 74, 75] },
    ],
  },
  {
    name: "T2", mode: "tram", color: "#458227",
    branches: [
      { stops: [76, 35, 77, 20, 78, 79, 80, 26, 81, 82, 83] },
    ],
  },
  {
    name: "T3", mode: "tram", color: "#15576F",
    branches: [
      { stops: [84, 36, 85, 27, 86, 87, 88, 21, 89, 90, 91] },
    ],
  },
  {
    name: "T4", mode: "tram", color: "#664E1E",
    branches: [
      { stops: [92, 93, 44, 94, 26, 95, 96, 97, 21, 98, 49, 99, 100] },
    ],
  },
  {
    name: "T5", mode: "tram", color: "#0C790C",
    branches: [
      { stops: [101, 102, 7, 103, 79, 104, 2, 105, 87, 106, 8, 107, 108] },
    ],
  },
  {
    name: "T6", mode: "tram", color: "#8212BA",
    branches: [
      { stops: [109, 1, 110, 71, 111, 2, 112, 96, 113, 3, 114] },
    ],
  },
  {
    name: "B1", mode: "bus", color: "#0F0FBD",
    branches: [
      { stops: [115, 116, 117, 118, 119, 120, 121, 122, 64, 123, 124, 125, 25, 126, 45] },
    ],
  },
  {
    name: "B2", mode: "bus", color: "#661E1E",
    branches: [
      { stops: [127, 128, 39, 129, 130, 131, 132, 133, 134, 135, 108, 136, 100, 137, 138, 139] },
    ],
  },
  {
    name: "B3", mode: "bus", color: "#827527",
    branches: [
      { stops: [140, 141, 142, 143, 144, 145, 115, 146, 66, 147, 148, 149, 150, 151, 152, 153] },
    ],
  },
  {
    name: "N9", mode: "bus", color: "#5C5F66",
    branches: [
      { stops: [6, 101, 7, 79, 2, 96, 3, 90, 22], service: "Nights only" },
    ],
  },
  {
    name: "K1", mode: "cable", color: "#990F62",
    branches: [
      { stops: [55, 127, 128], name: "funicular", service: "Apr–Oct" },
    ],
  },
  {
    name: "A1", mode: "bus", color: "#632782",
    branches: [
      { stops: [40, 154, 155, 40], name: "airport loop", service: "Every 10 min", direction: "forward" },
    ],
  },
]

const TERRAIN: (Omit<Terrain, 'id'> & { kind: TerrainKind })[] = [
  {"kind": "green", "name": "Beacon Down", "geo": [{"x": 2070, "y": 120}, {"x": 2430, "y": 120}, {"x": 2430, "y": 390}, {"x": 2070, "y": 390}], "schematic": [{"x": 2070, "y": 120}, {"x": 2430, "y": 120}, {"x": 2430, "y": 390}, {"x": 2070, "y": 390}], "closed": true, "hidden": false, "holes": [], "fill": "hatch"},
  {"kind": "builtup", "name": "Dockside", "geo": [{"x": 1260, "y": 1320}, {"x": 1890, "y": 1320}, {"x": 1890, "y": 1470}, {"x": 1260, "y": 1470}], "schematic": [{"x": 1260, "y": 1335}, {"x": 1890, "y": 1335}, {"x": 1890, "y": 1470}, {"x": 1260, "y": 1470}], "closed": true, "hidden": false, "holes": [], "fill": "stipple"},
  {"kind": "label", "name": "RIVER ALD", "geo": [{"x": 450, "y": 1104}], "schematic": [{"x": 450, "y": 1107}], "closed": false, "hidden": false, "holes": [], "fill": "solid", "text": {"size": 20, "italic": true, "color": "#3E7E96", "letterSpacing": 3, "opacity": 0.75, "align": "start"}},
  {"kind": "label", "name": "BEACON DOWN", "geo": [{"x": 2250, "y": 258}], "schematic": [{"x": 2250, "y": 258}], "closed": false, "hidden": false, "holes": [], "fill": "solid", "text": {"size": 14, "weight": 700, "color": "#4B6A16", "opacity": 0.7, "letterSpacing": 2}},
  {"kind": "label", "name": "DOCKSIDE", "geo": [{"x": 1575, "y": 1419}], "schematic": [{"x": 1575, "y": 1425}], "closed": false, "hidden": false, "holes": [], "fill": "solid", "text": {"size": 16, "weight": 600, "opacity": 0.45, "letterSpacing": 4}},
  {"kind": "label", "name": "to the coast →", "geo": [{"x": 2400, "y": 1209}], "schematic": [{"x": 2400, "y": 1380}], "closed": false, "hidden": false, "holes": [], "fill": "solid", "text": {"size": 13, "italic": true, "opacity": 0.6, "align": "end"}},
]

const PLACEMENTS: Omit<Placement, 'id'>[] = [
  {"what": {"kind": "legend"}, "geo": {"x": 2600, "y": 700}, "schematic": {"x": 2600, "y": 700}, "scale": 1, "angle": 0, "opacity": 1, "locked": false, "hidden": false, "label": "Lines"},
  {"what": {"kind": "titleBlock"}, "geo": {"x": 400, "y": 40}, "schematic": {"x": 400, "y": 40}, "scale": 1, "angle": 0, "opacity": 1, "locked": false, "hidden": false, "label": "Aldbury"},
  {"what": {"kind": "northArrow"}, "geo": {"x": 2600, "y": 120}, "schematic": {"x": 2600, "y": 120}, "scale": 1, "angle": 0, "opacity": 1, "locked": false, "hidden": false},
  {"what": {"kind": "scaleBar"}, "geo": {"x": 2600, "y": 250}, "schematic": {"x": 2600, "y": 250}, "scale": 1, "angle": 0, "opacity": 1, "locked": false, "hidden": false, "label": "2 km"},
]

/** Indices into `STATIONS`. */
const TRANSFERS: { a: number; b: number; note: string }[] = [
  { a: 70, b: 79, note: "4 min walk" },
  { a: 27, b: 86, note: "5 min walk" },
  { a: 7, b: 44, note: "3 min walk" },
]

export function createSampleProject(): Project {
  const base = createEmptyProject('Aldbury — example network')
  base.id = newProjectId()

  const ids: StationId[] = []
  const stations: Station[] = STATIONS.map(([name, sx, sy, gx, gy, zone, extra]) => {
    const id = newStationId()
    ids.push(id)
    return makeStation(id, name, { x: sx, y: sy }, {
      geo: { x: gx, y: gy },
      zone: zone || undefined,
      ...(extra ?? {}),
    })
  })

  const lines: Line[] = LINES.map((l) => ({
    id: newLineId(),
    name: l.name,
    mode: l.mode,
    color: l.color,
    branches: l.branches.map((b): Branch =>
      makeBranch(newBranchId(), b.stops.map((i) => ids[i]), {
        passes: (b.passes ?? []).map((i) => ids[i]),
        name: b.name,
        service: b.service,
        direction: b.direction ?? 'both',
        color: b.color,
      }),
    ),
    bends: {},
    hidden: false,
  }))

  const terrain: Terrain[] = TERRAIN.map((t) => makeTerrain(newTerrainId(), t.kind, t))
  const placements: Placement[] = PLACEMENTS.map((p) => ({ ...p, id: newPlacementId() }))
  const transfers = TRANSFERS.map((t) => ({
    id: newTransferId(),
    a: ids[t.a],
    b: ids[t.b],
    note: t.note,
    hidden: false,
  }))

  return {
    ...base,
    stations,
    lines,
    terrain,
    placements,
    transfers,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
