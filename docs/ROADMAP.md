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

Part G records a second round, from 2026-09-18: what looking at the exported map turned
up, and the five phases built in response.

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


---

## Part G — The second round

Everything in Parts A–F shipped, the map was exported and looked at, and this is what
looking at it turned up. Ordered as it was built, in five phases: a safety net first,
because the whole of Part F's postscript was about not having one.

### Phase 0 — the safety net, and four defects

**G1. Rendering had no test at all — DONE.** Part F said so and nothing had changed:
every drawing change was checked by eye, and four of six bugs in one stretch were things
a person had to notice in a screenshot. `scripts/render.tsx` mounts the *real* layer
components through React's server renderer — there is no second drawing routine to drift
out of step with the first — and `scripts/visual.ts` rasterises each case with resvg and
compares it against a committed picture, writing the difference to disk when it fails.
Fifteen cases: eight scenarios, three templates, an inset, a tidy before-and-after, and
the whole example map.

A small fraction of differing pixels is allowed, because text is rasterised by whatever
fonts the machine has. Tight enough to catch a moved label, loose enough not to cry over
a pixel of antialiasing.

**G2. Lines swerved where a corridor gained a member — DONE.** Offsets were centred on
each corridor independently, so a bundle that picked up a third line pushed the two
already running together half a spacing sideways and back again after the junction. Dead
straight lines drew as shallow S-bends, visible either side of Kestrel Hill and again at
Sallowfield. Corridors are now walked, and where two adjacent ones share lines the second
is shifted so the shared lines keep their place — what real maps do: hold what was
already there, put the newcomer on the outside.

**G3. Marks floated off the line they named — DONE.** Corridor offsets are right in the
middle of a straight run and wrong at a corner, where the mitre pulls the stroke away
from the station. A mark is now snapped onto the stroke it names, taken only when it
keeps clear of the other marks, since two dots on top of each other is a worse lie than
one slightly off its track.

Found while fixing it: **the overlap checker was pairing marks with calling lines by
position**, which falls out of step the moment a caller has no mark of its own. Each mark
now names its own line. The checker had been reporting the wrong station for months.

**G4. Labels vanished under furniture — DONE.** A legend or a title block is opaque and
drawn last, so a name that landed under one was simply gone — invisible while composing,
discovered only in the exported file. Labels now treat placements as obstacles.

**G5. Fare zones read as rendering debris — DONE.** A bare grey digit floating above the
name, colliding with whatever label sat above. Now a boxed chip on the label's own line,
with room reserved for it.

**G6. The tool bar sat on top of the map — DONE.** Parked in the top-left, it hid part of
the diagram permanently and no amount of panning helped. A forty-eight pixel gutter costs
that width once and hides nothing.

### Phase 1 — two features that already existed and could not be reached

Both of these were in the model from the beginning. Neither was usable, which is the same
thing as not existing.

**G7. Corridor order — DONE.** Reachable only by selecting a *line*, buried at the foot of
that inspector, listed one row per *segment* and capped at six of them. Putting the red
line above the blue one along a twelve-segment run meant twelve trips through a panel,
each identified by a pair of station names. Ordering is a question about a RUN:
`sharedRun` finds every corridor a pair of lines keeps each other company on, and one
move rewrites all of them in a single undoable step. Asked where you are looking, in the
station inspector.

**G8. Per-crossing overpasses — DONE.** Every crossing has always had its own gap, its own
choice of which line goes over, and its own off switch. The hit target was fourteen
diagram units — nine pixels at a working zoom — invisible, with no hover and no cursor
change. Now a constant size on screen, lit under the pointer, ringed wherever it has been
tuned, shift-clickable, with one button to apply the settings to every crossing the same
two lines make.

> Worth generalising: a feature nobody can find is a feature that does not exist, and the
> code review that would have caught both of these is not reading the module — it is
> trying to use it.

### Phase 2 — drawing speed

**G9. Draw along existing track — DONE.** A line sharing a corridor for twenty stops meant
twenty clicks, and one misplaced click put a kink in a run that should have been dead
straight. `trackPath` walks the physical graph weighted by distance — a different question
from the journey planner, which prices changes because passengers care about them.

**G10. Calling patterns — DONE.** Every stop, every other, the others, or copied from
another branch. The ends always call.

### Phase 3 — output

**G11. The exported page — DONE.** It was a picture with a clickable legend. It now pans,
zooms, finds a station, plans a journey, and restores any of that from the URL. Pan and
zoom are forty lines of arithmetic against the viewBox rather than a library, because the
file has to open from a USB stick with no network.

One trap worth recording: the page is built inside a template literal, where a lone `\s`
is quietly eaten. The viewBox regex reached the browser as `/s+/`, split the attribute on
the letter s, and broke zooming in a way that reads as a maths bug and is an escaping one.

**G12. Export presets and trim marks — DONE.** Poster, banner, wallpaper, shareable page.
Each is a set of numbers someone would otherwise have to know.

### Phase 4 — composition

**G13. Leader lines — DONE.** Twenty-eight of the example's hundred and fifty-six labels
lay across a line; now nine do. A second ring, and a hairline from the stop to any label
pushed out to it. The leader is the point: a label moved out of its own crowd stops
obviously belonging to anything.

**G14. Fare bands — DONE.** One button stamps every stop inside a band with its zone, and
bands alternate their wash.

**G15. The history browser — DONE.** In the command palette, not a panel: the thing you
want twice a week and never want taking up room.

**G16. Starting shapes — DONE.** Grid, radial and ring, trunk and branches. The radial one
runs diameters rather than four spokes, because four lines all starting in the middle put
four terminus bullets on the same dot.

**G17. Interchange insets — DONE.** Tied to a station rather than a coordinate, and it
redraws the map inside itself rather than cloning a picture, so it cannot show a version
that no longer exists. The export skips id-stamping inside one, because a duplicate id in
an SVG silently changes what `clipPath` and `use` resolve to in someone else's editor.

**G18. Tidy — DONE, and a reversal.** Part F's "Not built" said whole-network
auto-beautify was out because octilinear layout is NP-hard and would land near 70%. That
was the right call about a *solver* and the wrong call about the feature. Hill climbing
after Stott and Rodgers lands near 70%, takes a fifth of a second on the 156-stop example,
and is one undo away from never having happened — which turns the argument against it into
the reason to have it.

Deterministic by construction: fixed order, fixed candidate directions, no randomness
anywhere, because a layout that shuffles on every run cannot be reviewed or committed.
Relative position is a hard cost, so it never turns a line inside out to save a few
degrees — a map where two stops have swapped sides is a different map, not a tidier one.

### What this round did not do

- **Time, as a year slider.** Deliberately not built. The useful version for someone
  *drawing* a map is phases — "Today", "Proposed extension" — with each station and branch
  tagged and a dropdown switching what is drawn. Same payoff, no chronology to maintain,
  and it reuses the `status` field. Waiting on a decision.
- **Minutes and isochrones.** Dropped. Journeys are priced in stops and changes, and that
  is what this tool is for.
- **Touch and mobile** remain untested. Desktop Chromium only, as before.
