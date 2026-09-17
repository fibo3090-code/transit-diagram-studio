/**
 * The symbol lab.
 *
 * Every awkward shape, drawn side by side, with the overlap checker's verdict printed
 * under each one. It exists because the failure mode being hunted here is visual: a
 * station symbol that lies across a line which does not stop there is perfectly valid
 * data and a perfectly wrong map, and no amount of reading the code catches it.
 *
 * Two things are on screen at once, deliberately:
 *
 *   the drawing   — what someone would actually see
 *   the verdict   — what `findOverlaps` measured about it
 *
 * If they ever disagree, the checker is wrong and needs fixing before the renderer does.
 * That is the point of showing both rather than trusting either.
 */

import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { buildNetwork } from '../domain/network'
import { describeOverlap, findOverlaps } from '../domain/overlaps'
import { createSampleProject } from '../domain/sample'
import { scenarios, type Scenario } from '../domain/scenarios'
import { contentBounds } from '../export/exporters'
import { BadgeLayer, LabelsLayer, LinesLayer, StationsLayer } from '../render/layers'

export const Route = createFileRoute('/lab')({ component: Lab })

const noop = () => {}

/** One scenario, drawn at whatever scale fits the box. */
function Board({ scenario, width = 560, height = 340 }: { scenario: Scenario; width?: number; height?: number }) {
  const { project } = scenario
  const network = useMemo(() => buildNetwork(project), [project])
  const b = useMemo(() => contentBounds(project, 'schematic', 48), [project])

  const w = Math.max(1, b.maxX - b.minX)
  const h = Math.max(1, b.maxY - b.minY)
  const zoom = Math.min(width / w, height / h)
  const tx = width / 2 - (b.minX + w / 2) * zoom
  const ty = height / 2 - (b.minY + h / 2) * zoom

  return (
    <svg
      width={width}
      height={height}
      className="rounded-xl border border-slate-200"
      style={{ background: project.style.background }}
    >
      <g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
        <LinesLayer
          project={project}
          network={network}
          space="schematic"
          selectedLines={new Set()}
          onLinePointerDown={noop}
          onSegmentPointerDown={noop}
          onCrossingPointerDown={noop}
        />
        <StationsLayer
          project={project}
          network={network}
          space="schematic"
          selected={new Set()}
          onPointerDown={noop}
        />
        <LabelsLayer project={project} network={network} space="schematic" onPointerDown={noop} />
        <BadgeLayer project={project} network={network} space="schematic" />
      </g>
    </svg>
  )
}

function Case({ scenario }: { scenario: Scenario }) {
  const findings = useMemo(() => findOverlaps(scenario.project), [scenario.project])
  const ok = findings.length === 0

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-slate-900">{scenario.title}</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-500">
            {scenario.expectation}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${
            ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}
        >
          {ok ? 'clean' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
        </span>
      </header>

      <Board scenario={scenario} />

      {!ok && (
        <ul className="mt-3 space-y-1">
          {findings.map((f, i) => (
            <li key={i} className="text-[12px] leading-relaxed text-red-700">
              {describeOverlap(f)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Lab() {
  const cases = useMemo(() => scenarios(), [])
  const [showExample, setShowExample] = useState(false)
  const example = useMemo(() => (showExample ? createSampleProject() : null), [showExample])
  const exampleFindings = useMemo(
    () => (example ? findOverlaps(example) : []),
    [example],
  )

  const total = cases.reduce((n, c) => n + findOverlaps(c.project).length, 0)

  return (
    <div className="mx-auto max-w-[1220px] p-6">
      <header className="mb-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold text-slate-900">Symbol lab</h1>
          <Link to="/" className="text-[13px] text-slate-500 underline hover:text-slate-900">
            back to your maps
          </Link>
        </div>
        <p className="mt-1.5 max-w-3xl text-[13.5px] leading-relaxed text-slate-600">
          The shapes that break station symbols, drawn beside what the overlap checker
          measured about each. A mark must sit on the stroke of every service that stops,
          and must never touch one that runs past — get that backwards and the map states
          the opposite of the timetable.
        </p>
        <p className="mt-2 text-[13px] font-medium text-slate-700">
          {total === 0
            ? `All ${cases.length} cases clean.`
            : `${total} finding${total === 1 ? '' : 's'} across ${cases.length} cases.`}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {cases.map((c) => (
          <Case key={c.id} scenario={c} />
        ))}
      </div>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">The example network</h2>
            <p className="mt-0.5 text-[12.5px] text-slate-500">
              The same check over the whole shipped map. Slower, so it is off by default.
            </p>
          </div>
          <button
            onClick={() => setShowExample((v) => !v)}
            className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-[12.5px] font-medium text-white"
          >
            {showExample ? 'Hide' : 'Run it'}
          </button>
        </div>

        {example && (
          <>
            <p className="mt-3 text-[13px] font-medium text-slate-700">
              {exampleFindings.length} finding{exampleFindings.length === 1 ? '' : 's'} —{' '}
              {exampleFindings.filter((f) => f.alongside).length} where a line runs alongside
              without stopping, {exampleFindings.filter((f) => f.kind === 'marks-collide').length}{' '}
              collisions.
            </p>
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
              {exampleFindings.map((f, i) => (
                <li key={i} className="text-[12px] leading-relaxed text-slate-600">
                  {describeOverlap(f)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
