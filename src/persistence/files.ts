/**
 * Importing screenshots and reading/writing project files.
 *
 * Images are downscaled on import so the stitched canvas stays inside the browser's
 * reliable range. Above roughly 8000px on a side, canvas allocation starts failing in
 * ways that are hard to diagnose, so we cap here rather than let it surprise you later.
 */

import { newAssetId, newImageId, newBlobKey } from '../domain/ids'
import { normalizeProject } from '../domain/migrate'
import type { Asset, ImageLayer, Project, ProjectFile } from '../domain/types'
import { PROJECT_VERSION } from '../domain/types'
import { getBlob, putBlob } from './idb'

/** Longest edge any single imported screenshot is allowed to keep. */
export const MAX_IMAGE_EDGE = 4096

export interface ImportedImage {
  layer: ImageLayer
  /** True when the source was larger than `MAX_IMAGE_EDGE` and got resampled. */
  downscaled: boolean
}

async function decode(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file)
}

/**
 * Read one file into an ImageLayer, storing its bytes in IndexedDB. `at` positions the
 * layer's top-left on the stitched canvas.
 */
export async function importImageFile(
  file: File,
  at: { x: number; y: number },
): Promise<ImportedImage> {
  const bitmap = await decode(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  let blob: Blob
  if (scale === 1) {
    blob = file
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get a 2D context to resize the image')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not encode the resized image'))),
        'image/png',
      ),
    )
  }
  bitmap.close()

  const blobKey = newBlobKey()
  await putBlob(blobKey, blob)

  return {
    downscaled: scale < 1,
    layer: {
      id: newImageId(),
      name: file.name.replace(/\.[^.]+$/, ''),
      blobKey,
      width,
      height,
      x: at.x,
      y: at.y,
      opacity: 1,
      locked: false,
      hidden: false,
      placedBy: 'manual',
    },
  }
}

/** Symbols are drawn small. Anything larger is wasted bytes on every save. */
export const MAX_ASSET_EDGE = 512

/**
 * Read files into library assets.
 *
 * Separate from image import because the two want different things: a screenshot is
 * traced over at 4096px and never drawn small, while an asset is a mark placed at
 * roughly stop size. Capping assets far lower keeps a project with fifty markers from
 * carrying fifty full-resolution pictures.
 */
export async function importAssetFiles(files: File[]): Promise<Asset[]> {
  const out: Asset[] = []
  for (const file of files) {
    const bitmap = await decode(file)
    const scale = Math.min(1, MAX_ASSET_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    let blob: Blob = file
    if (scale < 1) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Could not get a 2D context to resize the asset')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, width, height)
      blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Could not encode the asset'))),
          'image/png',
        ),
      )
    }
    bitmap.close()

    const blobKey = newBlobKey()
    await putBlob(blobKey, blob)
    out.push({
      id: newAssetId(),
      name: file.name.replace(/\.[^.]+$/, ''),
      blobKey,
      width,
      height,
      source: 'import',
    })
  }
  return out
}

/**
 * Cut a rectangle out of the imported screenshots and keep it as an asset.
 *
 * This is the point of the whole asset system. The art you want -- a landmark, an
 * airport glyph, a faction crest -- is already sitting in the project, traced under the
 * network. Rather than asking someone to find the original file, crop it in another
 * program and import the result, the region is composited straight off the layers that
 * are already on screen.
 *
 * Every visible, unlocked layer overlapping the rectangle is drawn in project order, so
 * a crop that straddles two stitched tiles comes out whole rather than clipped at the
 * seam.
 */
export async function cropAssetFromImages(
  layers: ImageLayer[],
  rect: { x: number; y: number; width: number; height: number },
  name: string,
): Promise<Asset | null> {
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < 4 || height < 4) return null

  const overlapping = layers.filter(
    (l) =>
      !l.hidden &&
      l.x < rect.x + rect.width &&
      l.x + l.width > rect.x &&
      l.y < rect.y + rect.height &&
      l.y + l.height > rect.y,
  )
  if (overlapping.length === 0) return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get a 2D context to crop')

  for (const layer of overlapping) {
    const blob = await getBlob(layer.blobKey)
    if (!blob) continue
    const bitmap = await createImageBitmap(blob)
    // The layer may be displayed at a different size than its natural pixels.
    const sx = bitmap.width / layer.width
    const sy = bitmap.height / layer.height
    ctx.drawImage(
      bitmap,
      (rect.x - layer.x) * sx,
      (rect.y - layer.y) * sy,
      rect.width * sx,
      rect.height * sy,
      0,
      0,
      width,
      height,
    )
    bitmap.close()
  }

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the crop'))),
      'image/png',
    ),
  )

  const blobKey = newBlobKey()
  await putBlob(blobKey, blob)
  return { id: newAssetId(), name, blobKey, width, height, source: 'crop' }
}

/**
 * Import several files at once, laid out left to right in a rough grid so nothing
 * lands exactly on top of anything else before you start arranging.
 */
export async function importImageFiles(
  files: File[],
  origin = { x: 0, y: 0 },
): Promise<ImportedImage[]> {
  const out: ImportedImage[] = []
  const columns = Math.ceil(Math.sqrt(files.length))
  let cursorX = origin.x
  let cursorY = origin.y
  let rowHeight = 0

  for (let i = 0; i < files.length; i++) {
    const imported = await importImageFile(files[i], { x: cursorX, y: cursorY })
    out.push(imported)
    cursorX += imported.layer.width
    rowHeight = Math.max(rowHeight, imported.layer.height)
    if ((i + 1) % columns === 0) {
      cursorX = origin.x
      cursorY += rowHeight
      rowHeight = 0
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Could not read image data'))
    r.readAsDataURL(blob)
  })

const dataUrlToBlob = (url: string): Promise<Blob> => fetch(url).then((r) => r.blob())

/**
 * Serialize a project. `embedImages` produces a self-contained file you can move
 * between machines; without it the file stays small but expects the screenshots to be
 * re-imported.
 */
export async function serializeProject(
  project: Project,
  embedImages: boolean,
): Promise<string> {
  const file: ProjectFile = {
    format: 'transit-diagram-studio',
    version: PROJECT_VERSION,
    project,
  }

  if (embedImages) {
    const images: Record<string, string> = {}
    for (const layer of project.images) {
      const blob = await getBlob(layer.blobKey)
      if (blob) images[layer.blobKey] = await blobToDataUrl(blob)
    }
    file.images = images
  }

  return JSON.stringify(file, null, 2)
}

export interface ParsedProjectFile {
  project: Project
  restoredImages: number
  missingImages: number
}

/** Parse a project file, restoring any embedded screenshots into IndexedDB. */
export async function parseProjectFile(text: string): Promise<ParsedProjectFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }

  const file = parsed as Partial<ProjectFile>
  if (file.format !== 'transit-diagram-studio' || !file.project) {
    throw new Error('That file is not a Transit Diagram Studio project.')
  }
  if ((file.version ?? 0) > PROJECT_VERSION) {
    throw new Error(
      `That project was saved by a newer version (v${file.version}). This build reads up to v${PROJECT_VERSION}.`,
    )
  }

  let restoredImages = 0
  if (file.images) {
    for (const [key, dataUrl] of Object.entries(file.images)) {
      try {
        await putBlob(key, await dataUrlToBlob(dataUrl))
        restoredImages++
      } catch {
        // A single unreadable image should not sink the whole project.
      }
    }
  }

  let missingImages = 0
  for (const layer of file.project.images) {
    if (!(await getBlob(layer.blobKey))) missingImages++
  }

  return { project: normalizeProject(file.project), restoredImages, missingImages }
}

// ---------------------------------------------------------------------------
// Browser save / open
// ---------------------------------------------------------------------------

const safeName = (name: string) =>
  name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'network'

export function downloadText(text: string, filename: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export const projectFilename = (project: Project) => `${safeName(project.name)}.tds.json`

/** Open a file picker and return the chosen files. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve(input.files ? [...input.files] : [])
    // A cancelled picker fires nothing in some browsers; resolve empty on blur.
    input.oncancel = () => resolve([])
    input.click()
  })
}
