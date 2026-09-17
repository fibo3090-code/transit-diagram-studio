/**
 * How big a piece of map furniture is.
 *
 * Shared deliberately. The renderer needs it to draw a legend and to put a selection
 * box round it; `contentBounds` needs it to size an export and to fit the view. When
 * those two disagreed, furniture placed in the margin drew correctly on screen and was
 * then cropped out of the exported file — the legend explaining the map did not survive
 * being saved.
 *
 * The legend is the one that has to be computed rather than fixed: it grows a row per
 * visible line, because it derives itself from the project.
 */

import type { Placement, Project } from './types'

export interface Extent {
  w: number
  h: number
}

/** Unscaled size. Multiply by `placement.scale` for what is actually drawn. */
export function placementExtent(project: Project, pl: Placement): Extent {
  const fs = project.style.fontSize
  switch (pl.what.kind) {
    case 'asset': {
      const a = project.assets.find((x) => x.id === (pl.what as { assetId: string }).assetId)
      return { w: a?.width ?? 0, h: a?.height ?? 0 }
    }
    case 'northArrow':
      return { w: 44, h: 44 }
    case 'scaleBar':
      return { w: 200, h: 18 }
    case 'legend': {
      const rows = project.lines.filter((l) => !l.hidden).length
      return { w: 210, h: fs * 1.75 * (rows + 1) + 12 }
    }
    case 'titleBlock':
      return { w: 280, h: 74 }
    case 'frame':
      return { w: 900, h: 640 }
    default:
      return { w: 0, h: 0 }
  }
}

/** Size as drawn, after the placement's own scale. */
export function placementDrawnExtent(project: Project, pl: Placement): Extent {
  const e = placementExtent(project, pl)
  return { w: e.w * pl.scale, h: e.h * pl.scale }
}
