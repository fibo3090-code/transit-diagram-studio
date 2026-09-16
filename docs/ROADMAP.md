# Audit and roadmap

Everything found while auditing Transit Diagram Studio on 2026-09-16, and what is
proposed in response. Three passes are recorded here:

1. a **code audit** (two defects, both fixed),
2. a **model audit** — can the data model express a real transit network,
3. a **UI audit** — the app was run and driven in a real browser, not read.

Status labels: **FIXED** · **DONE**.

**Everything in this document has now been implemented.** Each item keeps its original
finding and evidence, with the resolution recorded under it, so the reasoning survives
alongside the fix.

---

## Part A — Code defects

### A1. Literal NUL bytes made two source files unsearchable — **FIXED** (`c7a95f2`)

`csv.ts` and `routing.ts` each embedded a raw `0x00` as a composite-map-key
separator:

```ts
const key = `${lineName}<NUL>${branch}`                    // csv.ts:179
const key = (station, line) => `${station}<NUL>${line}`    // routing.ts:50
```

NUL as a delimiter is sound reasoning — it cannot occur in a station or line name.
Writing it as a raw byte is not. `file` reported both as `data`, and grep treats such
files as binary and matches nothing, so project-wide searches skipped them silently:

```
$ grep -rl "parseCsv" src/
src/domain/domain.test.ts  src/ui/panels.tsx      # the file that DEFINES it is missing
```

Replaced with the `\u0000` escape — byte-identical at runtime, and the files are text
again. Worth remembering as a class of bug: invisible in an editor and in `cat`, and it
degrades tooling rather than failing.

### A2. README drift — **FIXED** (`c7a95f2`)

Checked every claim against the code. Corrections: the test count said 35, the suite
runs 54; `Ctrl+Y` (redo) and `Backspace` (delete) were undocumented; CSV import **and
export** and the network checker existed only as lines in the architecture tree, never
as features; four style presets and six built-in modes were undocumented; the tree
omitted `crossings.ts`, `defaults.ts`, `ids.ts` and `sample.ts`.

---

## Part B — Model gaps

Verified by running the real domain code against each case, not by reading it.

### Tier 1 — structurally unrepresentable

#### B1. Express / skip-stop services — **DONE**

The single largest gap. A branch is a list of stops and geometry runs between
consecutive stops, so an express that skips stations draws straight from A to D and
cannot follow the local alignment through what it passes:

```
EXPRESS: express drawn through 2 points (A->D direct)
EXPRESS: B is an interchange? false   <- express passes B, model cannot say
                                         "passes through without stopping"
```

Note the irony: `snapping.ts` has an elaborate **levels** system whose entire purpose is
the "passes through without stopping" *position*, but the model has no way to record
that it happened.

Blocks: the NYC subway wholesale, RER A/B, the Metropolitan line, every Japanese
rapid/express tier.

**Done.** `Branch.passes` holds the stations run through without calling. They are woven
into the centreline by projecting each onto the segment it sits along — `passes` stays a
flat set rather than a per-segment map, because which segment a skipped station belongs
to is something the geometry already knows. They get no `stopIndices` entry, so no symbol
is drawn, and they are absent from `stops`, so the planner will not board or alight
there. Editable per stop in the line inspector.

#### B2. No direction — **DONE**

`routing.ts:105-108` pushes both `before` and `after`, so every branch is bidirectional
by construction:

```
ONE-WAY: A->C stops 2 | C->A stops 2   <- identical
```

Blocks: one-way running, terminal loops, the Chicago Loop, unidirectional tram circuits.

**Done.** `Branch.direction`. `ridesFrom` offers only the following stop on a `forward`
branch, so the return journey has to find another way round, as a passenger would. The
canvas marks one-way running with arrowheads along the segment rather than only at the
end.

#### B3. Closed loops get a phantom terminus — **DONE** (was a genuine bug)

Feeding a ring `[A,B,C,D,A]`:

```
LOOP: termini = 1   <- draws a terminus cap on a closed loop
```

`buildNetwork` computes endpoints as first + last stop minus interior stops. On a ring
the join station is both, and the interior test does not catch it. The Circle line,
Yamanote, Koltsevaya and the Glasgow Subway all get a spurious route-bullet cap.

**Done.** `isRing()` names the case and `buildNetwork` skips endpoints for it.

#### B4. A station is only a name and a position — **DONE**

`Station` carries `id, name, geo, schematic, modes[], label, notes?`. There is no fare
zone, no step-free/accessibility flag, no secondary name. Confirmed absent across the
codebase — `zone`, `fare`, `step-free`, `wheelchair` return zero hits.

Blocks: the official London map (zones and step-free symbols are *on* it), and every
bilingual network — Tokyo, Seoul, Brussels, Montréal.

**Done.** All four, plus a `SymbolRef` override. Badges are drawn as paths rather than
emoji or an icon font, because the export has to be a self-contained SVG that opens
anywhere and a glyph depending on an installed font is not that.

#### B5. No custom assets — **DONE**

`StationSymbol` is a closed enum of exactly five: `'tick' | 'circle' | 'square' |
'diamond' | 'anchor'`. Images render in a single `<g data-layer="screenshots">` that is
always the backdrop. So a landmark, airport glyph or faction crest cannot be lifted out
of the source map and placed on the diagram. The only free annotation is
`Terrain.kind === 'label'`, hardcoded at `fontSize × 1.4`, `opacity 0.45`, centred
(`layers.tsx:159-176`) — no per-label size, colour, weight or rotation.

**Done.** A project-level library, and the part that matters: **Crop** cuts a region
straight out of the screenshots already in the project, compositing every overlapping
layer so a crop across a stitched seam comes out whole. Assets serve as station symbols
or as free-standing markers. Free text is fully styleable.

### Tier 2 — expressible but awkward

| # | Gap | Note |
|---|---|---|
| B6 | **Terrain is a single ring** (`geo: Vec2[]`) | No holes. An island in a lake needs two shapes and careful z-order. |
| B7 | **No service variants by time** | Night buses, peak-only branches. `Branch.name` carries no validity. |
| B8 | **Colour is per-line, not per-branch** | Northern line / S-Bahn style branch colouring impossible. |
| B9 | **No station status** | `hidden` is a boolean; "under construction" (usually dashed) has nowhere to live. |
| B10 | **No true curves** | Only `cornerRadius` on bends. Sweeping arcs (Madrid, Berlin) unachievable. |

> Tier 1 was verified empirically. Tier 2 was verified by reading the types, so treat it
> as slightly softer.

**All ten are now implemented.** Project schema v2 → v3; every change is additive and
`normalizeProject` fills it in, so stored projects keep the behaviour they had. B6 gained
hole *creation* as well as rendering — being able to clear holes but never make one would
have left the feature useless.

---

## Part C — UI problems

Found by running the app and driving it in Chromium at 1024 / 1280 / 1440.

| # | Problem | Evidence |
|---|---|---|
| C1 | **Export unreachable below ~1100px.** Clipped off the toolbar; no overflow, no wrap. | At 1024px the button is at `x=1087`, `visible:false`. Fullscreen on a 1920 screen hides this; split-screen loses Export. |
| C2 | **Map opens clipped.** No fit-on-open; you must know to press `F`. | Lines ran off the right edge on load; `F` fitted the whole network. |
| C3 | **Map style vanishes when anything is selected.** Preset / Fine tuning / Transport modes / What to show live inside `NothingSelected` (`panels.tsx:949`). To restyle you must first deselect. | Confirmed in code and in two screenshots. |
| C4 | **Line reorder is hover-only** — while the panel states *"Order matters: this list decides which sits on which side."* | `Move up` / `Move down` present in the accessibility tree, invisible in the screenshot. |
| C5 | **Hit targets are 19×19px** at 80% zoom (~24px at 100%). | Measured from `[data-station]` bounding boxes. |
| C6 | **Left panel is mostly empty** in Route (two dropdowns) and Layers (one item) — ~290×800px for almost nothing. | |
| C7 | **Project title truncates mid-word** — "Aldbury — example n". | |
| C8 | **Tab strip is cramped** — the active "Route" pill overlaps the "Layers" label. | |
| C9 | **ALL-CAPS 10px grey labels throughout** (`CORRIDOR SPACING`, `CROSSING GAP — HEIGHT`). Low contrast, jargon, hard to scan. | |
| C10 | **The toolbar mixes six unrelated concerns** in one 64px band: title, space toggle, six tools, snapping, undo/redo, save state, export. | |

**All ten are now fixed.** See Part D for what replaced the frame.

### Root cause

Not styling — the visual craft is fine and the diagram output is good. **Three
orthogonal axes fight over two panels:**

- *what am I working on* — network, terrain, images, data, routes
- *what is selected* — station, line, transfer, crossing (ten inspector states)
- *global settings* — style, modes, view

The left panel mixes axes 1 and 3; the right panel alternates between 2 and 3, and 3
loses whenever 2 appears (C3). Nothing has a place you can learn, which is what "hard to
navigate" actually means here.

---

## Part D — Proposed design

One rule: **every zone owns exactly one axis and is never replaced by another.**

```
+----+--------------+------------------------------+-----------------+
| [] |              |                              |  SELECTION      |  <- axis 2
| <> |   BROWSER    |                              |  (station/line/ |
| ## |   list for   |          CANVAS              |   transfer...)  |
| [] |   the active |      +--+ floating tools     +-----------------+
| -> |   mode       |      +--+ (vertical)         |  MAP STYLE      |  <- axis 3
| !  |              |                              |  always present |
+----+--------------+------------------------------+-----------------+
  ^ axis 1            status - zoom - validation - search
```

- **D1. Left icon rail (~56px)** — Network, Terrain, Images, Assets, Data, Route,
  Checks. Replaces the cramped five-tab text strip (C8), scales to the new modes, and
  gives each a stable keyboard number.
- **D2. Browser panel** — resizable and collapsible, so its emptiness stops mattering
  (C6).
- **D3. Tools become a floating vertical bar over the canvas.** Frees the 64px band
  (C10) and, crucially, **scales** — asset placement, zone drawing and a
  mark-as-pass-through tool are all coming, and a labelled horizontal row will not take
  three more.
- **D4. Right panel permanently split** — selection on top, **Map style always below**.
  Fixes C3 outright.
- **D5. Top bar shrinks** to title · Map/Diagram · save state · **Export (pinned)** ·
  overflow. Fixes C1.

### Where each model change lands

| Feature | Home |
|---|---|
| Express / skip-stop (B1) | Line inspector gains a **stop-list editor** — missing today; `removeStop` exists in the store with no visible list. Each row: "stops here" / "passes through". |
| Direction (B2) | Per-branch segmented control: `Both` / `One-way`. |
| Loop fix (B3) | No UI needed; add a `ring` badge on the line row so detection is visible. |
| Fare zones (B4) | Rail mode or terrain kind, plus a `Zone` field on the station. |
| Badges / accessibility (B4) | Badge picker row in the station inspector. |
| Secondary name (B4) | Station inspector, under the name field. |
| Station status (B9) | Segmented `Open / Under construction / Planned`, drives dashed rendering. |
| Custom assets (B5) | New **Assets** rail mode — the library. |
| Terrain holes (B6) | "Add hole" on a selected shape. |
| Branch colour (B8) | Per-branch colour override in the Line inspector. |

### Asset library

Today: five fixed symbols, backdrop-only images, hardcoded free text. Proposed:

1. **Cropped symbols from your own map** — marquee a region of an imported screenshot,
   name it, it joins the library. The source art is already in the project.
2. **Station symbol overrides** — any asset usable as a stop symbol.
3. **Free-standing markers** — airport, port, landmark, stadium, faction crest.
4. **Real text annotations** — size, weight, colour, rotation, alignment. Replaces the
   hardcoded label.
5. **Auto-legend block**, placeable, derived from lines and modes.
6. **North arrow and scale bar.**
7. **Title block / cartouche** for the finished poster.
8. **Line badge shapes** — circle, roundel, hexagon, square, diamond. NYC, London and
   Tokyo all differ; today you get one look.
9. **Terrain fills** — hatching, stipple, texture.
10. **Poster frame / border.**

Assets store as project data so a project file stays self-contained, as it already does
for images.

### Visual direction

- Kill the ALL-CAPS 10px grey labels (C9). Sentence case, 12px, real contrast.
  `CROSSING GAP — HEIGHT` becomes "Crossing gap (across)" with a one-line hint.
- Sliders get units and a live preview on hover.
- Persistent drag handles for reorder, not hover-only (C4).
- Invisible padded hit areas (~36-40px) while keeping the drawn symbol small (C5).
- Density toggle — comfortable / compact.
- Dark chrome, so the white export canvas reads as paper.

---

## Part E — Phasing

All four phases are complete. What each one actually took is recorded in the commit
messages; the notes below are what the phases were for.

**Phase 0 — quick wins, no redesign**
Fit-on-open (C2) · pin Export with overflow (C1) · always-visible Map style (C3) ·
visible reorder handles (C4) · larger hit targets (C5) · `Delete` for every selectable
type · ring-terminus bug (B3).

**Phase 1 — the frame**
Icon rail (D1) · floating tools (D3) · resizable panels (D2) · split right panel (D4) ·
shrunk top bar (D5).

**Phase 2 — model and UI together**
Stop-list editor and `passes[]` (B1) · direction (B2) · station fields (B4, B9).

**Phase 3 — assets**
The library and the ten asset types.

---

## Part F — What was and was not verified

- **Marquee multi-select** — was listed here as unconfirmed because synthetic clicks do
  not fire the app's `pointerdown` handlers. Since resolved: the gesture exists
  (`gesture.kind === 'marquee'` in `MapView`), and the crop tool now reuses it.
- **Tier 1 model gaps** were reproduced against running code before being fixed, and the
  fixes are held by 29 of the 83 domain checks.
- **Tier 2 model gaps** (B6–B10) were read from the types rather than executed. Their
  implementations are covered by tests for the geometry (curves, holes) but not for the
  rendering.
- **Rendering is not under test at all.** There is no component or visual-regression
  suite; every rendering change here was checked by eye in a browser at 1024 / 1280 /
  1440. That is the largest remaining gap in this project's safety net.
- **Touch and mobile were never tested.** Desktop Chromium only.
- **Theme verification was briefly misleading.** The screenshot tool served stale frames
  while `getComputedStyle` reported the truth; a fresh browser session settled it. Worth
  remembering that a screenshot is evidence about a pipeline, not only about a page.
