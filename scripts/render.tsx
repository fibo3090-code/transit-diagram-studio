/**
 * The map, drawn outside a browser.
 *
 * The same layer components the editor mounts, rendered to a string by React's server
 * renderer. That is the whole point: a second drawing routine written for tests would
 * drift from the real one and then pass while the app was broken.
 *
 * Only the layers that survive an export are here. The editing furniture — grid, guides,
 * handles, draft, ghosts — is what `buildSvg` strips on the way out, so leaving it out
 * produces the same picture the export does.
 */

import { renderToStaticMarkup } from 'react-dom/server'

import { buildNetwork } from '../src/domain/network'
import type { Space } from '../src/domain/network'
import type { Project } from '../src/domain/types'
import { contentBounds } from '../src/export/exporters'
import {
  BadgeLayer,
  LabelsLayer,
  LinesLayer,
  PlacementLayer,
  StationsLayer,
  TerrainLayer,
  TransferLayer,
} from '../src/render/layers'

const noop = () => {}
const none = new Set<never>()

export function renderProjectSvg(project: Project, space: Space = 'schematic'): string {
  const network = buildNetwork(project)
  const b = contentBounds(project, space, 48, network)
  const w = Math.max(1, b.maxX - b.minX)
  const h = Math.max(1, b.maxY - b.minY)

  const body = renderToStaticMarkup(
    <g>
      {project.view.showTerrain && (
        <TerrainLayer project={project} space={space} selected={none} onPointerDown={noop} />
      )}
      <LinesLayer
        project={project}
        network={network}
        space={space}
        selectedLines={none}
        onLinePointerDown={noop}
        onSegmentPointerDown={noop}
        onCrossingPointerDown={noop}
      />
      <TransferLayer project={project} space={space} selected={none} onPointerDown={noop} />
      <StationsLayer
        project={project}
        network={network}
        space={space}
        selected={none}
        onPointerDown={noop}
      />
      <LabelsLayer project={project} network={network} space={space} onPointerDown={noop} />
      <BadgeLayer project={project} network={network} space={space} />
      {project.view.showPlacements && (
        <PlacementLayer project={project} space={space} selected={none} onPointerDown={noop} />
      )}
    </g>,
  )

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}"`,
    ` viewBox="${b.minX} ${b.minY} ${w} ${h}">`,
    `<rect x="${b.minX}" y="${b.minY}" width="${w}" height="${h}" fill="${project.style.background}"/>`,
    body,
    `</svg>`,
  ].join('')
}
