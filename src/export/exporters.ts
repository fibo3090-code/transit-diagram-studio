/**
 * Export.
 *
 * The SVG is produced by cloning the LIVE surface rather than re-drawing the map a
 * second way. That means what you export is by construction what you saw — there is no
 * second renderer to drift out of step with the first.
 */

import { boundsSize, boundsValid, emptyBounds, growBounds, padBounds, type Bounds } from '../domain/geometry'
import { placementDrawnExtent } from '../domain/furniture'
import { modeById } from '../domain/defaults'
import { buildNetwork, type Network, type Space } from '../domain/network'
import { labelRects } from '../domain/labels'
import type { Project } from '../domain/types'

/** Layers that exist only to help you edit, and must never reach a poster. */
const UI_ONLY_LAYERS = ['guides', 'ghosts', 'grid', 'draft', 'bends']

export interface ExportOptions {
  space: Space
  includeScreenshots: boolean
  includeTitleBlock: boolean
  includeLegend: boolean
  padding: number
}

export const defaultExportOptions = (space: Space): ExportOptions => ({
  space,
  includeScreenshots: space === 'geo',
  includeTitleBlock: false,
  includeLegend: false,
  padding: 60,
})

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export function contentBounds(
  project: Project,
  space: Space,
  padding: number,
  network?: Network,
): Bounds {
  const b = emptyBounds()
  for (const s of project.stations) growBounds(b, s[space])
  // Names are content. The page has to be big enough for the lettering, not just for
  // the dots — otherwise the outermost label is sliced in half by the edge of the file.
  if (project.view.showLabels) {
    const net = network ?? buildNetwork(project)
    for (const r of labelRects(project, net, space)) {
      growBounds(b, { x: r.x, y: r.y })
      growBounds(b, { x: r.x + r.w, y: r.y + r.h })
    }
  }
  for (const t of project.terrain) for (const p of t[space]) growBounds(b, p)
  for (const line of project.lines) {
    for (const list of Object.values(line.bends)) {
      for (const bend of list) growBounds(b, bend[space])
    }
  }
  // Furniture counts as content. Without this a legend or a title block placed in the
  // margin renders on screen and is then cropped out of the export.
  if (project.view.showPlacements) {
    for (const pl of project.placements) {
      if (pl.hidden) continue
      const { w, h } = placementDrawnExtent(project, pl)
      growBounds(b, { x: pl[space].x - w / 2, y: pl[space].y - h / 2 })
      growBounds(b, { x: pl[space].x + w / 2, y: pl[space].y + h / 2 })
    }
  }
  if (space === 'geo') {
    for (const img of project.images) {
      if (img.hidden) continue
      growBounds(b, { x: img.x, y: img.y })
      growBounds(b, { x: img.x + img.width, y: img.y + img.height })
    }
  }
  if (!boundsValid(b)) return { minX: 0, minY: 0, maxX: 800, maxY: 600 }
  return padBounds(b, padding)
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * Clone the live surface into a standalone SVG document. Layer groups keep their
 * `data-layer` / `data-line-name` attributes and gain matching ids, so the file opens
 * in Inkscape or Illustrator as named layers rather than a heap of loose paths.
 */
export function buildSvg(
  liveSvg: SVGSVGElement,
  project: Project,
  opts: ExportOptions,
): string {
  const bounds = contentBounds(project, opts.space, opts.padding)
  const { width, height } = boundsSize(bounds)

  const clone = liveSvg.cloneNode(true) as SVGSVGElement

  // Drop the pan/zoom transform — the viewBox does that job in the exported file.
  const root = clone.querySelector('g')
  root?.removeAttribute('transform')

  for (const name of UI_ONLY_LAYERS) {
    clone.querySelector(`[data-layer="${name}"]`)?.remove()
  }
  if (!opts.includeScreenshots) {
    clone.querySelector('[data-layer="screenshots"]')?.remove()
  }

  // Anything the editor drew for its own benefit — selection rings, invisible hit
  // targets, handles — is tagged `data-ui` at the point it is created, so one rule
  // removes all of it rather than a growing list of colour and attribute guesses.
  for (const el of clone.querySelectorAll('[data-ui]')) el.remove()

  // Belt and braces for any transparent paint that escaped the tagging: it carries no
  // ink and would only bloat the file.
  for (const el of clone.querySelectorAll('[fill="transparent"], [stroke="transparent"]')) {
    el.remove()
  }

  for (const el of clone.querySelectorAll('[style]')) el.removeAttribute('style')
  for (const el of clone.querySelectorAll('[data-hit]')) el.removeAttribute('data-hit')

  for (const g of clone.querySelectorAll('[data-layer]')) {
    g.setAttribute('id', `layer-${g.getAttribute('data-layer')}`)
  }
  for (const g of clone.querySelectorAll('[data-line-name]')) {
    const name = g.getAttribute('data-line-name') || 'line'
    g.setAttribute('id', `line-${name.replace(/[^\w-]+/g, '-')}`)
  }

  const extras: string[] = []
  if (opts.includeLegend) extras.push(legendSvg(project, bounds))
  if (opts.includeTitleBlock) extras.push(titleBlockSvg(project, bounds))

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    ` width="${Math.round(width)}" height="${Math.round(height)}"`,
    ` viewBox="${bounds.minX} ${bounds.minY} ${width} ${height}">`,
    `<rect x="${bounds.minX}" y="${bounds.minY}" width="${width}" height="${height}" fill="${project.style.background}"/>`,
    clone.innerHTML,
    extras.join(''),
    `</svg>`,
  ].join('')
}

function legendSvg(project: Project, b: Bounds): string {
  const visible = project.lines.filter((l) => !l.hidden)
  if (visible.length === 0) return ''
  const x = b.minX + 24
  let y = b.minY + 30
  const rows = visible
    .map((l) => {
      const mode = modeById(project.modes, l.mode)
      const row =
        `<line x1="${x}" y1="${y}" x2="${x + 34}" y2="${y}" stroke="${l.color}" ` +
        `stroke-width="${mode.strokeWidth * project.style.strokeScale}" stroke-linecap="round"/>` +
        `<text x="${x + 44}" y="${y}" dy="0.34em" font-family="${project.style.fontFamily}" ` +
        `font-size="${project.style.fontSize}" fill="${project.style.foreground}">` +
        `${escapeXml(l.name)} · ${escapeXml(mode.name)}</text>`
      y += 22
      return row
    })
    .join('')
  return `<g id="layer-legend">${rows}</g>`
}

function titleBlockSvg(project: Project, b: Bounds): string {
  const x = b.minX + 24
  const y = b.maxY - 30
  return (
    `<g id="layer-title">` +
    `<text x="${x}" y="${y}" font-family="${project.style.fontFamily}" font-size="${project.style.fontSize * 1.7}" ` +
    `font-weight="600" fill="${project.style.foreground}">${escapeXml(project.name)}</text>` +
    `<text x="${x}" y="${y + project.style.fontSize * 1.5}" font-family="${project.style.fontFamily}" ` +
    `font-size="${project.style.fontSize * 0.85}" fill="${project.style.foreground}" opacity="0.6">` +
    `${project.stations.length} stations · ${project.lines.filter((l) => !l.hidden).length} lines</text>` +
    `</g>`
  )
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  )

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/** Browser canvases stop being reliable well before the spec limit; cap and report. */
const MAX_PNG_EDGE = 16384

export interface RasterResult {
  blob: Blob
  width: number
  height: number
  /** Set when the requested scale had to be reduced to stay within canvas limits. */
  clampedFrom?: number
}

export async function rasterize(svgText: string, scale: number): Promise<RasterResult> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    img.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not render the diagram to an image.'))
      img.src = url
    })

    const baseW = img.naturalWidth || img.width
    const baseH = img.naturalHeight || img.height

    let applied = scale
    const longest = Math.max(baseW, baseH) * scale
    if (longest > MAX_PNG_EDGE) applied = MAX_PNG_EDGE / Math.max(baseW, baseH)

    const width = Math.max(1, Math.round(baseW * applied))
    const height = Math.max(1, Math.round(baseH * applied))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D context for the export.')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, width, height)

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not encode the PNG.'))),
        'image/png',
      ),
    )

    return {
      blob,
      width,
      height,
      clampedFrom: applied < scale ? scale : undefined,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
