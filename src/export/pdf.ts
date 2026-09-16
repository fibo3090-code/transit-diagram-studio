/**
 * PDF export, written directly — no library.
 *
 * The map is rasterized at print resolution and embedded LOSSLESSLY: raw RGB samples
 * compressed with the platform's deflate via `CompressionStream`, carried as a
 * `/FlateDecode` image. JPEG would have been less code but puts ringing artefacts
 * around every line on a flat-colour diagram, which is exactly the wrong trade here.
 *
 * For a true vector page, export SVG — that stays the lossless-at-any-size route, and
 * every print shop accepts it.
 */

import { rasterize } from './exporters'

export interface PageSize {
  id: string
  name: string
  /** Points (1/72 inch). */
  width: number
  height: number
}

export const PAGE_SIZES: PageSize[] = [
  { id: 'a4', name: 'A4', width: 595.28, height: 841.89 },
  { id: 'a3', name: 'A3', width: 841.89, height: 1190.55 },
  { id: 'a2', name: 'A2', width: 1190.55, height: 1683.78 },
  { id: 'a1', name: 'A1', width: 1683.78, height: 2383.94 },
  { id: 'a0', name: 'A0', width: 2383.94, height: 3370.39 },
  { id: 'letter', name: 'Letter', width: 612, height: 792 },
  { id: 'tabloid', name: 'Tabloid', width: 792, height: 1224 },
]

export interface PdfOptions {
  pageSizeId: string
  orientation: 'auto' | 'portrait' | 'landscape'
  /** Margin in points. */
  margin: number
  /** Target print resolution. 300 is photographic; 150 is plenty for flat colour. */
  dpi: number
  /** Split across several sheets that can be trimmed and taped into a poster. */
  tile: boolean
}

export const defaultPdfOptions = (): PdfOptions => ({
  pageSizeId: 'a3',
  orientation: 'auto',
  margin: 28,
  dpi: 200,
  tile: false,
})

// ---------------------------------------------------------------------------
// Low-level PDF writing
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // `deflate` (zlib wrapper) is what /FlateDecode expects, not `deflate-raw`.
  const cs = new CompressionStream('deflate')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const escapeText = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)

// ---------------------------------------------------------------------------
// Building the document
// ---------------------------------------------------------------------------

interface Tile {
  col: number
  row: number
}

export interface PdfResult {
  blob: Blob
  pages: number
  pixelWidth: number
  pixelHeight: number
  /** Set when the requested dpi had to drop to stay inside canvas limits. */
  reducedDpi?: number
}

export async function buildPdf(
  svgText: string,
  opts: PdfOptions,
  title: string,
): Promise<PdfResult> {
  const base = PAGE_SIZES.find((p) => p.id === opts.pageSizeId) ?? PAGE_SIZES[0]

  // Rasterize once at the requested resolution. The SVG is authored in CSS pixels,
  // so points -> pixels is dpi/72.
  const targetScale = opts.dpi / 72
  const raster = await rasterize(svgText, targetScale)
  const imgW = raster.width
  const imgH = raster.height
  const aspect = imgW / imgH

  const landscape =
    opts.orientation === 'landscape' ||
    (opts.orientation === 'auto' && aspect > 1)
  const pageW = landscape ? base.height : base.width
  const pageH = landscape ? base.width : base.height

  const contentW = Math.max(1, pageW - opts.margin * 2)
  const contentH = Math.max(1, pageH - opts.margin * 2)

  // Where the image lands, in points.
  let drawW: number
  let drawH: number
  const tiles: Tile[] = []

  if (opts.tile) {
    // Fill the width of one sheet, then spill down and across as many as it takes.
    const scale = contentW / imgW
    drawW = imgW * scale
    drawH = imgH * scale
    const cols = 1
    const rows = Math.max(1, Math.ceil(drawH / contentH))
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push({ col: c, row: r })
  } else {
    const scale = Math.min(contentW / imgW, contentH / imgH)
    drawW = imgW * scale
    drawH = imgH * scale
    tiles.push({ col: 0, row: 0 })
  }

  // --- image samples ----------------------------------------------------

  const bitmap = await createImageBitmap(raster.blob)
  const canvas = document.createElement('canvas')
  canvas.width = imgW
  canvas.height = imgH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not read the rendered map back for the PDF.')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const rgba = ctx.getImageData(0, 0, imgW, imgH).data

  // PDF /DeviceRGB wants three samples per pixel; composite alpha onto white so a
  // transparent background prints as paper rather than black.
  const rgb = new Uint8Array(imgW * imgH * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255
    rgb[j] = Math.round(rgba[i] * a + 255 * (1 - a))
    rgb[j + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a))
    rgb[j + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a))
  }
  const imageData = await deflate(rgb)

  // --- objects ----------------------------------------------------------

  const objects: Uint8Array[] = []
  const addObject = (body: Uint8Array | string): number => {
    objects.push(typeof body === 'string' ? enc.encode(body) : body)
    return objects.length // 1-based object numbers
  }

  // Reserve: 1 catalog, 2 pages, 3 image, 4 font; pages follow.
  const catalogId = 1
  const pagesId = 2
  const imageId = 3
  const fontId = 4
  const firstPageId = 5

  const pageIds = tiles.map((_, i) => firstPageId + i * 2)
  const contentIds = tiles.map((_, i) => firstPageId + i * 2 + 1)

  addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  addObject(
    `<< /Type /Pages /Count ${tiles.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  )
  objects.push(
    concat([
      enc.encode(
        `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
          `/Length ${imageData.length} >>\nstream\n`,
      ),
      imageData,
      enc.encode('\nendstream'),
    ]),
  )
  addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`)

  for (let i = 0; i < tiles.length; i++) {
    const { col, row } = tiles[i]
    // PDF's origin is bottom-left, so the top tile row sits highest in y.
    const x = opts.margin - col * contentW
    const y = opts.margin - drawH + (row === 0 ? drawH : drawH - row * contentH)
    const yPlaced = opts.tile
      ? opts.margin + contentH - drawH + row * contentH
      : opts.margin + (contentH - drawH) / 2
    const xPlaced = opts.tile ? x : opts.margin + (contentW - drawW) / 2
    void y

    const footer =
      tiles.length > 1
        ? `BT /F1 8 Tf ${opts.margin} ${opts.margin * 0.4} Td (${escapeText(title)} — sheet ${i + 1} of ${tiles.length}) Tj ET\n`
        : ''

    const content =
      `q\n` +
      `${opts.margin} ${opts.margin} ${contentW} ${contentH} re W n\n` +
      `${drawW.toFixed(3)} 0 0 ${drawH.toFixed(3)} ${xPlaced.toFixed(3)} ${yPlaced.toFixed(3)} cm\n` +
      `/Im0 Do\n` +
      `Q\n` +
      footer

    addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> ` +
        `/Contents ${contentIds[i]} 0 R >>`,
    )
    addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }

  // --- assemble ---------------------------------------------------------

  const header = enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const chunks: Uint8Array[] = [header]
  const offsets: number[] = []
  let offset = header.length

  for (let i = 0; i < objects.length; i++) {
    const prefix = enc.encode(`${i + 1} 0 obj\n`)
    const suffix = enc.encode('\nendobj\n')
    offsets.push(offset)
    const body = objects[i]
    chunks.push(prefix, body, suffix)
    offset += prefix.length + body.length + suffix.length
  }

  const xrefStart = offset
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`
  xref +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R ` +
    `/Info << /Title (${escapeText(title)}) /Producer (Transit Diagram Studio) >> >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`
  chunks.push(enc.encode(xref))

  return {
    blob: new Blob([concat(chunks) as BlobPart], { type: 'application/pdf' }),
    pages: tiles.length,
    pixelWidth: imgW,
    pixelHeight: imgH,
    reducedDpi: raster.clampedFrom ? Math.round((imgW / (imgW / targetScale)) * 72) : undefined,
  }
}
