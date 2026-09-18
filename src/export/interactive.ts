/**
 * Interactive HTML export.
 *
 * One self-contained file: the exported SVG, a legend, and a little script that lets a
 * reader click a line to isolate it and hover a station to see what calls there. No
 * server, no dependencies, no network access — it opens from a USB stick.
 *
 * It reuses `buildSvg`, so the picture is the same one the editor draws, and the layer
 * and line ids that export already stamps are exactly what the script needs.
 */

import { modeById } from '../domain/defaults'
import type { Project } from '../domain/types'

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

/** Inline JSON safely: `</script>` inside a string would close the tag early. */
const safeJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e')

export interface InteractiveOptions {
  /** Shown above the map. Falls back to the project name. */
  title?: string
  subtitle?: string
}

export function buildInteractiveHtml(
  svg: string,
  project: Project,
  opts: InteractiveOptions = {},
): string {
  const title = opts.title?.trim() || project.name || 'Transit map'
  const visible = project.lines.filter((l) => !l.hidden)

  const lines = visible.map((l) => ({
    id: l.id,
    name: l.name || 'Untitled',
    color: l.color,
    mode: modeById(project.modes, l.mode).name,
    stops: [...new Set(l.branches.flatMap((b) => b.stops))].length,
    // The stop lists are what lets the page plan a journey of its own, rather than
    // shipping a picture of a network nobody can ask anything about.
    branches: l.branches.map((b) => b.stops),
    oneWay: l.branches.map((b) => b.direction === 'forward'),
  }))

  const stationNames: Record<string, string> = {}
  for (const s of project.stations) stationNames[s.id] = s.name || 'Unnamed'

  const walks = project.transfers
    .filter((t) => !t.hidden)
    .map((t) => [t.a, t.b, t.note] as const)

  // Strip the XML prolog: it is only valid at the very start of a document, and here the
  // SVG is being inlined into HTML.
  const inlineSvg = svg.replace(/^<\?xml[^?]*\?>\s*/, '')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #f1f3f7;
    --panel: #ffffff;
    --ink: #0f172a;
    --muted: #64748b;
    --rule: #e2e8f0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1219; --panel: #151d27; --ink: #e6ebf2; --muted: #93a1b5; --rule: #26313f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header { padding: 24px 24px 12px; }
  h1 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
  .sub { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
  .wrap { display: flex; gap: 16px; align-items: flex-start; padding: 12px 24px 32px; flex-wrap: wrap; }
  .map {
    flex: 1 1 560px; min-width: 0; background: var(--panel);
    border: 1px solid var(--rule); border-radius: 14px; padding: 8px; overflow: auto;
  }
  .map svg { display: block; width: 100%; height: auto; }
  aside { flex: 0 0 240px; }
  .card {
    background: var(--panel); border: 1px solid var(--rule);
    border-radius: 14px; padding: 12px;
  }
  .eyebrow {
    font: 600 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: .14em; text-transform: uppercase; color: var(--muted);
    margin: 0 0 8px;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li + li { margin-top: 2px; }
  .line {
    display: flex; align-items: center; gap: 9px; width: 100%;
    background: none; border: 0; border-radius: 8px; padding: 6px 8px;
    color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  .line:hover { background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .line[aria-pressed="true"] { background: color-mix(in srgb, var(--ink) 12%, transparent); }
  .swatch { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; }
  .line .name { flex: 1 1 auto; min-width: 0; font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .line .meta { flex: 0 0 auto; font: 10px ui-monospace, monospace; color: var(--muted); }
  .hint { margin: 10px 0 0; font-size: 12px; color: var(--muted); line-height: 1.45; }
  button.reset {
    margin-top: 10px; width: 100%; padding: 7px; border-radius: 8px;
    border: 1px solid var(--rule); background: none; color: inherit;
    font: 500 12.5px inherit; cursor: pointer;
  }
  button.reset:hover { background: color-mix(in srgb, var(--ink) 7%, transparent); }
  /* Dimming is done on the SVG groups the editor already labels. */
  svg [data-line].dim { opacity: .12; }
  svg [data-layer="labels"].dim, svg [data-layer="badges"].dim { opacity: .25; }
  #tip {
    position: fixed; z-index: 10; pointer-events: none; opacity: 0;
    transform: translate(-50%, -140%); transition: opacity .1s;
    background: var(--ink); color: var(--bg);
    padding: 6px 9px; border-radius: 7px; font-size: 12.5px; white-space: nowrap;
    box-shadow: 0 6px 20px -8px rgba(0,0,0,.5);
  }
  #tip b { display: block; font-size: 13px; }
  #tip span { opacity: .75; font-size: 11.5px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

  .bar { display: flex; gap: 8px; align-items: center; padding: 0 24px 10px; flex-wrap: wrap; }
  .bar input, .bar select {
    background: var(--panel); color: inherit; border: 1px solid var(--rule);
    border-radius: 9px; padding: 7px 10px; font: inherit; font-size: 13.5px; min-width: 0;
  }
  .bar input { flex: 1 1 220px; max-width: 320px; }
  .zoom { display: flex; gap: 4px; margin-left: auto; }
  .zoom button {
    width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--rule);
    background: var(--panel); color: inherit; font: 600 14px inherit; cursor: pointer;
  }
  .zoom button:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .map { cursor: grab; touch-action: none; }
  .map.dragging { cursor: grabbing; }
  #found {
    position: absolute; z-index: 5; background: var(--panel); border: 1px solid var(--rule);
    border-radius: 10px; padding: 4px; max-height: 260px; overflow: auto;
    box-shadow: 0 12px 30px -14px rgba(0,0,0,.45); min-width: 220px;
  }
  #found button {
    display: block; width: 100%; text-align: left; background: none; border: 0;
    color: inherit; font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 7px;
    cursor: pointer;
  }
  #found button:hover, #found button.on { background: color-mix(in srgb, var(--ink) 9%, transparent); }
  #found .where { color: var(--muted); font-size: 11px; }
  .leg { display: flex; gap: 8px; align-items: baseline; padding: 5px 0; }
  .leg .swatch { width: 10px; height: 10px; border-radius: 50%; margin-top: 4px; }
  .leg .what { font-size: 12.5px; }
  .leg .where { color: var(--muted); font-size: 11.5px; }
  .total { margin: 6px 0 0; font-size: 12px; color: var(--muted); }
  svg .mark { fill: none; stroke: var(--ink); stroke-width: 3; opacity: .9; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  ${opts.subtitle ? `<p class="sub">${escapeHtml(opts.subtitle)}</p>` : ''}
</header>

<div class="bar">
  <input id="search" type="search" placeholder="Find a station" autocomplete="off" aria-label="Find a station">
  <select id="from" aria-label="Journey from"><option value="">Journey from…</option></select>
  <select id="to" aria-label="Journey to"><option value="">…to</option></select>
  <div class="zoom">
    <button id="zin" title="Zoom in">+</button>
    <button id="zout" title="Zoom out">&minus;</button>
    <button id="zfit" title="Whole map">&#8862;</button>
  </div>
</div>

<div class="wrap">
  <div class="map" id="map">${inlineSvg}</div>
  <aside>
    <div class="card" id="journey" hidden>
      <p class="eyebrow">Journey</p>
      <div id="legs"></div>
      <button class="reset" id="clearRoute">Clear</button>
    </div>
    <div class="card" style="margin-top:12px">
      <p class="eyebrow">Lines</p>
      <ul id="legend"></ul>
      <button class="reset" id="reset" hidden>Show every line</button>
      <p class="hint">Click a line to follow it. Drag the map to pan, scroll to zoom. Hover a
      station to see what calls there.</p>
    </div>
  </aside>
</div>

<div id="tip" role="status" aria-live="polite"></div>

<script>
(function () {
  var LINES = ${safeJson(lines)};
  var NAMES = ${safeJson(stationNames)};
  var WALKS = ${safeJson(walks)};

  var svg = document.querySelector('#map svg');
  var legend = document.getElementById('legend');
  var reset = document.getElementById('reset');
  var tip = document.getElementById('tip');
  if (!svg) return;

  var byId = {};
  LINES.forEach(function (l) { byId[l.id] = l; });

  // The editor names each line group by its NAME, not its id, so match on that.
  function groupFor(line) {
    var safe = line.name.replace(/[^\\w-]+/g, '-');
    return svg.querySelector('#line-' + CSS.escape(safe));
  }

  var active = null;

  function apply() {
    LINES.forEach(function (l) {
      var g = groupFor(l);
      if (g) g.classList.toggle('dim', active !== null && l.id !== active);
    });
    ['labels', 'badges'].forEach(function (name) {
      var g = svg.querySelector('#layer-' + name);
      if (g) g.classList.toggle('dim', active !== null);
    });
    Array.prototype.forEach.call(legend.querySelectorAll('.line'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.id === active));
    });
    reset.hidden = active === null;
  }

  LINES.forEach(function (l) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.className = 'line';
    b.dataset.id = l.id;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML =
      '<span class="swatch" style="background:' + l.color + '"></span>' +
      '<span class="name"></span>' +
      '<span class="meta"></span>';
    b.querySelector('.name').textContent = l.name;
    b.querySelector('.meta').textContent = l.stops + ' stops';
    b.addEventListener('click', function () {
      active = active === l.id ? null : l.id;
      apply();
      if (active) location.hash = 'line=' + encodeURIComponent(l.name);
      else if (location.hash) history.replaceState(null, '', location.pathname);
    });
    li.appendChild(b);
    legend.appendChild(li);
  });

  reset.addEventListener('click', function () { active = null; apply(); });

  // Station tooltips, delegated so it costs one listener however big the map is.
  svg.addEventListener('mousemove', function (e) {
    var g = e.target.closest ? e.target.closest('[data-station]') : null;
    if (!g) { tip.style.opacity = '0'; return; }
    var ids = (g.getAttribute('data-station-lines') || '').split(' ').filter(Boolean);
    var served = ids.map(function (id) { return byId[id] ? byId[id].name : null; })
                    .filter(Boolean);
    var name = g.getAttribute('data-station-name') ||
               NAMES[g.getAttribute('data-station')] || 'Unnamed';
    tip.innerHTML = '';
    var strong = document.createElement('b');
    strong.textContent = name;
    tip.appendChild(strong);
    var sub = document.createElement('span');
    sub.textContent = served.length ? served.join(' · ') : 'No lines';
    tip.appendChild(sub);
    tip.style.left = e.clientX + 'px';
    tip.style.top = e.clientY + 'px';
    tip.style.opacity = '1';
  });
  svg.addEventListener('mouseleave', function () { tip.style.opacity = '0'; });

  // ---------------------------------------------------------------- pan and zoom
  //
  // Hand-rolled against the viewBox rather than pulled from a library: this file has to
  // open from a USB stick with no network, so every kilobyte is one that must justify
  // itself, and forty lines of arithmetic is cheaper than a dependency.
  // Double backslash on purpose: this whole page is inside a template literal, where a
  // lone \\s is quietly eaten and the regex reaches the browser as /s+/ — which splits the
  // viewBox on the letter s, yields one NaN, and breaks zooming in a way that looks like
  // a maths bug rather than an escaping one.
  var box = (svg.getAttribute('viewBox') || '0 0 1000 1000').split(/\\s+/).map(Number);
  var home = box.slice();
  function applyBox() { svg.setAttribute('viewBox', box.join(' ')); }
  function zoomBy(k, ax, ay) {
    var w = Math.min(home[2] * 4, Math.max(home[2] / 40, box[2] * k));
    var h = w * (home[3] / home[2]);
    box[0] += (box[2] - w) * ax;
    box[1] += (box[3] - h) * ay;
    box[2] = w; box[3] = h;
    applyBox();
  }
  var mapEl = document.getElementById('map');
  mapEl.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = svg.getBoundingClientRect();
    zoomBy(Math.exp(e.deltaY * 0.0016), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });

  var drag = null;
  mapEl.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, bx: box[0], by: box[1], w: svg.getBoundingClientRect().width };
    mapEl.classList.add('dragging');
    mapEl.setPointerCapture(e.pointerId);
  });
  mapEl.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var scale = box[2] / drag.w;
    box[0] = drag.bx - (e.clientX - drag.x) * scale;
    box[1] = drag.by - (e.clientY - drag.y) * scale;
    applyBox();
  });
  function endDrag() { drag = null; mapEl.classList.remove('dragging'); }
  mapEl.addEventListener('pointerup', endDrag);
  mapEl.addEventListener('pointercancel', endDrag);

  document.getElementById('zin').addEventListener('click', function () { zoomBy(0.7, 0.5, 0.5); });
  document.getElementById('zout').addEventListener('click', function () { zoomBy(1.4, 0.5, 0.5); });
  document.getElementById('zfit').addEventListener('click', function () {
    box = home.slice(); applyBox();
  });

  // ---------------------------------------------------------------- stations
  var stationEls = {};
  Array.prototype.forEach.call(svg.querySelectorAll('[data-station]'), function (g) {
    stationEls[g.getAttribute('data-station')] = g;
  });

  var overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  overlay.setAttribute('id', 'marks');
  svg.appendChild(overlay);

  function centreOf(id) {
    var g = stationEls[id];
    if (!g) return null;
    try {
      var b = g.getBBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    } catch (err) { return null; }
  }

  function clearMarks() { while (overlay.firstChild) overlay.removeChild(overlay.firstChild); }

  function markStation(id, r) {
    var c = centreOf(id);
    if (!c) return;
    var el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    el.setAttribute('cx', c.x); el.setAttribute('cy', c.y);
    el.setAttribute('r', r || 11);
    el.setAttribute('class', 'mark');
    overlay.appendChild(el);
  }

  function centreOn(id) {
    var c = centreOf(id);
    if (!c) return;
    box[0] = c.x - box[2] / 2;
    box[1] = c.y - box[3] / 2;
    applyBox();
  }

  // ---------------------------------------------------------------- search
  var search = document.getElementById('search');
  var found = null;
  var sortedStations = Object.keys(NAMES)
    .filter(function (id) { return stationEls[id]; })
    .sort(function (a, b) { return NAMES[a].localeCompare(NAMES[b]); });

  function linesAt(id) {
    var g = stationEls[id];
    var ids = g ? (g.getAttribute('data-station-lines') || '').split(' ').filter(Boolean) : [];
    return ids.map(function (x) { return byId[x] ? byId[x].name : null; }).filter(Boolean);
  }

  function closeFound() { if (found) { found.remove(); found = null; } }

  search.addEventListener('input', function () {
    closeFound();
    var q = search.value.trim().toLowerCase();
    if (!q) return;
    var hits = sortedStations.filter(function (id) {
      return NAMES[id].toLowerCase().indexOf(q) >= 0;
    }).slice(0, 12);
    if (!hits.length) return;
    found = document.createElement('div');
    found.id = 'found';
    var r = search.getBoundingClientRect();
    found.style.left = r.left + 'px';
    found.style.top = (r.bottom + window.scrollY + 4) + 'px';
    hits.forEach(function (id) {
      var b = document.createElement('button');
      b.innerHTML = '<span></span><span class="where"></span>';
      b.firstChild.textContent = NAMES[id];
      var served = linesAt(id);
      b.lastChild.textContent = served.length ? '  ' + served.join(' · ') : '';
      b.addEventListener('click', function () {
        clearMarks(); markStation(id, 14); centreOn(id);
        location.hash = 'station=' + encodeURIComponent(NAMES[id]);
        closeFound();
      });
      found.appendChild(b);
    });
    document.body.appendChild(found);
  });
  search.addEventListener('blur', function () { setTimeout(closeFound, 160); });

  // ---------------------------------------------------------------- journeys
  //
  // The search runs over (station, line) states, not stations, because what a passenger
  // pays for is changes as much as distance. A plain station graph cannot tell "stay on
  // this train" apart from "get off and wait for another", and happily returns journeys
  // nobody would make.
  var RIDE = 1, CHANGE = 4, WALK = 6;
  var edges = {};
  function link(a, b, lineId) {
    (edges[a] = edges[a] || []).push({ to: b, line: lineId });
  }
  LINES.forEach(function (l) {
    l.branches.forEach(function (stops, bi) {
      for (var i = 0; i < stops.length - 1; i++) {
        link(stops[i], stops[i + 1], l.id);
        if (!l.oneWay[bi]) link(stops[i + 1], stops[i], l.id);
      }
    });
  });
  WALKS.forEach(function (w) { link(w[0], w[1], '~walk'); link(w[1], w[0], '~walk'); });

  function plan(from, to) {
    if (!from || !to || from === to) return null;
    var best = {}, prev = {}, open = [];
    function push(key, cost, via) {
      if (best[key] !== undefined && best[key] <= cost) return;
      best[key] = cost; prev[key] = via; open.push(key);
    }
    push(from + '|', 0, null);
    var goal = null;
    while (open.length) {
      var at = 0;
      for (var i = 1; i < open.length; i++) if (best[open[i]] < best[open[at]]) at = i;
      var key = open.splice(at, 1)[0];
      var parts = key.split('|');
      var here = parts[0], onLine = parts[1];
      if (here === to) { goal = key; break; }
      (edges[here] || []).forEach(function (e) {
        var cost = best[key] +
          (e.line === '~walk' ? WALK : RIDE) +
          (onLine && e.line !== onLine && e.line !== '~walk' ? CHANGE : 0);
        push(e.to + '|' + e.line, cost, { key: key, line: e.line });
      });
    }
    if (!goal) return null;

    var steps = [], cur = goal;
    while (prev[cur]) { steps.unshift({ at: cur.split('|')[0], line: prev[cur].line }); cur = prev[cur].key; }
    steps.unshift({ at: from, line: null });

    var legs = [];
    steps.forEach(function (s, i) {
      if (i === 0) return;
      var last = legs[legs.length - 1];
      if (last && last.line === s.line) last.stops.push(s.at);
      else legs.push({ line: s.line, stops: [steps[i - 1].at, s.at] });
    });
    return { legs: legs, path: steps.map(function (s) { return s.at; }) };
  }

  var fromSel = document.getElementById('from');
  var toSel = document.getElementById('to');
  sortedStations.forEach(function (id) {
    [fromSel, toSel].forEach(function (sel) {
      var o = document.createElement('option');
      o.value = id; o.textContent = NAMES[id];
      sel.appendChild(o);
    });
  });

  var journeyCard = document.getElementById('journey');
  var legsEl = document.getElementById('legs');

  function showJourney() {
    var route = plan(fromSel.value, toSel.value);
    clearMarks();
    if (!route) {
      journeyCard.hidden = !(fromSel.value && toSel.value);
      legsEl.textContent = fromSel.value && toSel.value ? 'No way through.' : '';
      return;
    }
    journeyCard.hidden = false;
    legsEl.innerHTML = '';
    route.legs.forEach(function (leg) {
      var l = byId[leg.line];
      var row = document.createElement('div');
      row.className = 'leg';
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = l ? l.color : 'var(--muted)';
      var txt = document.createElement('div');
      var what = document.createElement('div');
      what.className = 'what';
      what.textContent = l ? l.name : 'Walk';
      var where = document.createElement('div');
      where.className = 'where';
      where.textContent = NAMES[leg.stops[0]] + ' → ' + NAMES[leg.stops[leg.stops.length - 1]] +
        '  (' + (leg.stops.length - 1) + ' stop' + (leg.stops.length === 2 ? '' : 's') + ')';
      txt.appendChild(what); txt.appendChild(where);
      row.appendChild(sw); row.appendChild(txt);
      legsEl.appendChild(row);
    });
    var total = document.createElement('p');
    total.className = 'total';
    total.textContent = (route.path.length - 1) + ' stops · ' +
      (route.legs.length - 1) + ' change' + (route.legs.length === 2 ? '' : 's');
    legsEl.appendChild(total);
    route.path.forEach(function (id, i) {
      markStation(id, i === 0 || i === route.path.length - 1 ? 13 : 8);
    });
    location.hash = 'from=' + encodeURIComponent(NAMES[fromSel.value]) +
      '&to=' + encodeURIComponent(NAMES[toSel.value]);
  }

  fromSel.addEventListener('change', showJourney);
  toSel.addEventListener('change', showJourney);
  document.getElementById('clearRoute').addEventListener('click', function () {
    fromSel.value = ''; toSel.value = '';
    journeyCard.hidden = true; clearMarks();
    if (location.hash) history.replaceState(null, '', location.pathname);
  });

  // ---------------------------------------------------------------- deep links
  //
  // A map you cannot point someone at is half a map. #station=, #line= and #from=&to=
  // all restore on load, so a link carries the thing you were looking at.
  function idForName(name) {
    var hit = sortedStations.filter(function (id) {
      return NAMES[id].toLowerCase() === name.toLowerCase();
    });
    return hit[0] || null;
  }

  function readHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    var q = {};
    raw.split('&').forEach(function (bit) {
      var kv = bit.split('=');
      q[kv[0]] = decodeURIComponent(kv.slice(1).join('=') || '');
    });
    if (q.line) {
      var l = LINES.filter(function (x) { return x.name.toLowerCase() === q.line.toLowerCase(); })[0];
      if (l) { active = l.id; apply(); }
    }
    if (q.station) {
      var id = idForName(q.station);
      if (id) { clearMarks(); markStation(id, 14); centreOn(id); }
    }
    if (q.from && q.to) {
      var a = idForName(q.from), b = idForName(q.to);
      if (a && b) { fromSel.value = a; toSel.value = b; showJourney(); }
    }
  }
  readHash();
  // A link followed from within the page changes the hash without reloading anything,
  // so the same reader clicking a second link would otherwise see nothing happen.
  window.addEventListener('hashchange', readHash);
})();
</script>
</body>
</html>
`
}
