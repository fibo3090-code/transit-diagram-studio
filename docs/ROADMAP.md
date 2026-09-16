# Audit and roadmap

Everything found while auditing Transit Diagram Studio on 2026-09-16, and what is
proposed in response. Three passes are recorded here:

1. a **code audit** (two defects, both fixed),
2. a **model audit** — can the data model express a real transit network,
3. a **UI audit** — the app was run and driven in a real browser, not read.

Status labels: **FIXED** · **OPEN** · **PROPOSED**.

Nothing in Part C or later has been implemented.

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

#### B1. Express / skip-stop services — **OPEN**

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

**Proposed:** `passes: StationId[]` on a branch — stations traversed without stopping.
Additive; `migrate.ts` defaults it to `[]`. Fixes express geometry, makes levels
snapping meaningful, and lets the planner refuse to board an express at a skipped stop.

#### B2. No direction — **OPEN**

`routing.ts:105-108` pushes both `before` and `after`, so every branch is bidirectional
by construction:

```
ONE-WAY: A->C stops 2 | C->A stops 2   <- identical
```

Blocks: one-way running, terminal loops, the Chicago Loop, unidirectional tram circuits.

**Proposed:** `direction: 'both' | 'forward'` per branch. Small routing change; canvas
draws an arrowhead when one-way.

#### B3. Closed loops get a phantom terminus — **OPEN, and a genuine bug**

Feeding a ring `[A,B,C,D,A]`:

```
LOOP: termini = 1   <- draws a terminus cap on a closed loop
```

`buildNetwork` computes endpoints as first + last stop minus interior stops. On a ring
the join station is both, and the interior test does not catch it. The Circle line,
Yamanote, Koltsevaya and the Glasgow Subway all get a spurious route-bullet cap.

**Proposed:** detect `stops[0] === stops.at(-1)` and emit no termini. Cheapest fix of
the five, and it removes a visibly wrong mark.

#### B4. A station is only a name and a position — **OPEN**

`Station` carries `id, name, geo, schematic, modes[], label, notes?`. There is no fare
zone, no step-free/accessibility flag, no secondary name. Confirmed absent across the
codebase — `zone`, `fare`, `step-free`, `wheelchair` return zero hits.

Blocks: the official London map (zones and step-free symbols are *on* it), and every
bilingual network — Tokyo, Seoul, Brussels, Montréal.

**Proposed:** `zone?: string`, `badges: BadgeId[]`, `nameSecondary?: string`,
`status: 'open' | 'construction' | 'planned'`.

#### B5. No custom assets — **OPEN**

`StationSymbol` is a closed enum of exactly five: `'tick' | 'circle' | 'square' |
'diamond' | 'anchor'`. Images render in a single `<g data-layer="screenshots">` that is
always the backdrop. So a landmark, airport glyph or faction crest cannot be lifted out
of the source map and placed on the diagram. The only free annotation is
`Terrain.kind === 'label'`, hardcoded at `fontSize × 1.4`, `opacity 0.45`, centred
(`layers.tsx:159-176`) — no per-label size, colour, weight or rotation.

**Proposed:** a project-level asset library. See Part D.

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

## Part F — Unverified

- **Marquee multi-select** could not be exercised: synthetic clicks do not fire the
  app's `pointerdown` handlers, so selection had to be driven by dispatching pointer
  events directly. Its behaviour is unconfirmed.
- **Touch and mobile** were not tested. Desktop Chromium only, at 1024 / 1280 / 1440.
- **Tier 2 model gaps** (B6-B10) were read from the types rather than executed.
