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
  }))

  const stationNames: Record<string, string> = {}
  for (const s of project.stations) stationNames[s.id] = s.name || 'Unnamed'

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
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  ${opts.subtitle ? `<p class="sub">${escapeHtml(opts.subtitle)}</p>` : ''}
</header>

<div class="wrap">
  <div class="map" id="map">${inlineSvg}</div>
  <aside>
    <div class="card">
      <p class="eyebrow">Lines</p>
      <ul id="legend"></ul>
      <button class="reset" id="reset" hidden>Show every line</button>
      <p class="hint">Click a line to follow it. Hover a station to see what calls there.</p>
    </div>
  </aside>
</div>

<div id="tip" role="status" aria-live="polite"></div>

<script>
(function () {
  var LINES = ${safeJson(lines)};
  var NAMES = ${safeJson(stationNames)};

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
})();
</script>
</body>
</html>
`
}
