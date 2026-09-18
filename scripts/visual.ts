/**
 * Visual regression checks.
 *
 * The roadmap's own postscript said it plainly: rendering was the one part of this
 * project with no safety net, and every drawing change was checked by eye. Four of the
 * last six bugs were things a person had to notice in a screenshot.
 *
 * So: render each case headlessly, rasterise it, and compare against a committed
 * baseline. A change that alters the picture fails loudly and writes the difference to
 * disk, and `npm run test:visual -- --update` is how you accept a change you meant.
 *
 * The comparison allows a small fraction of differing pixels, because text is rasterised
 * by whatever fonts the machine has and hinting is not identical everywhere. It is tight
 * enough to catch a moved label and loose enough not to cry over a pixel of antialiasing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Resvg } from '@resvg/resvg-js'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

import { createSampleProject } from '../src/domain/sample'
import { scenarios } from '../src/domain/scenarios'
import { createFromTemplate, TEMPLATES } from '../src/domain/templates'
import { tidyLayout } from '../src/domain/layout'
import { buildNetwork } from '../src/domain/network'
import type { Placement, Project } from '../src/domain/types'
import { renderProjectSvg } from './render'

// Relative to the package root, not to the bundle: this file is compiled into
// `node_modules/.tmp` before it runs, so `__dirname` would put the baselines there —
// where nothing is committed and every comparison silently passes.
const DIR = join(process.cwd(), 'scripts', '__snapshots__')
const UPDATE = process.argv.includes('--update')

/** Fraction of pixels allowed to differ before a case is called a regression. */
const TOLERANCE = 0.0015

interface Case {
  name: string
  project: Project
  /** Long edge of the raster. Small enough to stay quick, big enough to see a label. */
  width: number
}

function cases(): Case[] {
  const out: Case[] = scenarios().map((s) => ({ name: s.id, project: s.project, width: 640 }))
  for (const t of TEMPLATES) {
    out.push({ name: `template-${t.id}`, project: createFromTemplate(t.id), width: 760 })
  }
  // An inset redraws the map inside itself, which is the one piece of the renderer that
  // can recurse or collide with its own ids. Worth a picture of its own.
  {
    const project = createFromTemplate('radial')
    const busiest = [...project.stations].sort(
      (a, b) => b.modes.length - a.modes.length,
    )[0]
    const centre = project.stations.find((s) => s.name === 'Central') ?? busiest
    project.placements.push({
      id: 'pl_inset' as Placement['id'],
      what: { kind: 'inset', station: centre.id, radius: 150, zoom: 2.2 },
      geo: { x: 1500, y: 300 },
      schematic: { x: 1500, y: 300 },
      scale: 1,
      angle: 0,
      opacity: 1,
      locked: false,
      hidden: false,
    })
    out.push({ name: 'inset-callout', project, width: 900 })
  }

  // A crooked map and the same map tidied, so the solver's output is something you can
  // look at rather than a number in a test.
  {
    const crooked = createFromTemplate('grid')
    crooked.stations.forEach((st, i) => {
      st.schematic = {
        x: st.schematic.x + ((i * 37) % 121) - 60,
        y: st.schematic.y + ((i * 53) % 119) - 59,
      }
    })
    out.push({ name: 'tidy-before', project: crooked, width: 700 })

    const tidied = createFromTemplate('grid')
    tidied.stations.forEach((st, i) => {
      st.schematic = {
        x: st.schematic.x + ((i * 37) % 121) - 60,
        y: st.schematic.y + ((i * 53) % 119) - 59,
      }
    })
    const moved = tidyLayout(tidied, buildNetwork(tidied))
    for (const st of tidied.stations) {
      const next = moved.positions.get(st.id)
      if (next) st.schematic = next
    }
    out.push({ name: 'tidy-after', project: tidied, width: 700 })
  }

  out.push({ name: 'example-network', project: createSampleProject(), width: 2200 })
  return out
}

function rasterise(svg: string, width: number): PNG {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
    background: 'white',
  })
  return PNG.sync.read(r.render().asPng())
}

function main() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

  let failed = 0
  let written = 0
  let passed = 0

  for (const c of cases()) {
    const png = rasterise(renderProjectSvg(c.project), c.width)
    const file = join(DIR, `${c.name}.png`)

    if (UPDATE || !existsSync(file)) {
      writeFileSync(file, PNG.sync.write(png))
      written++
      console.log(`  ~ ${c.name} baseline written (${png.width}x${png.height})`)
      continue
    }

    const base = PNG.sync.read(readFileSync(file))
    if (base.width !== png.width || base.height !== png.height) {
      failed++
      writeFileSync(join(DIR, `${c.name}.actual.png`), PNG.sync.write(png))
      console.error(
        `  x ${c.name}: size changed ${base.width}x${base.height} -> ${png.width}x${png.height}`,
      )
      continue
    }

    const diff = new PNG({ width: png.width, height: png.height })
    const changed = pixelmatch(base.data, png.data, diff.data, png.width, png.height, {
      threshold: 0.12,
    })
    const ratio = changed / (png.width * png.height)
    if (ratio > TOLERANCE) {
      failed++
      writeFileSync(join(DIR, `${c.name}.actual.png`), PNG.sync.write(png))
      writeFileSync(join(DIR, `${c.name}.diff.png`), PNG.sync.write(diff))
      console.error(
        `  x ${c.name}: ${changed} pixels differ (${(ratio * 100).toFixed(3)}%) — see ` +
          `__snapshots__/${c.name}.diff.png`,
      )
    } else {
      passed++
    }
  }

  if (written > 0) console.log(`\n${written} baseline${written === 1 ? '' : 's'} written.`)
  if (failed > 0) {
    console.error(`\n${failed} visual check${failed === 1 ? '' : 's'} FAILED.`)
    console.error('If the change was intended: npm run test:visual -- --update\n')
    process.exit(1)
  }
  console.log(`✓ all ${passed + written} visual checks passed`)
}

main()
