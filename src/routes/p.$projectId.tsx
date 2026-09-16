import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

import type { ProjectId } from '../domain/types'
import {
  buildSvg,
  defaultExportOptions,
  rasterize,
  type ExportOptions,
} from '../export/exporters'
import { PAGE_SIZES, buildPdf, defaultPdfOptions, type PdfOptions } from '../export/pdf'
import { buildInteractiveHtml } from '../export/interactive'
import {
  downloadBlob,
  downloadText,
  importImageFiles,
  pickFiles,
  projectFilename,
  serializeProject,
} from '../persistence/files'
import { loadProject } from '../persistence/idb'
import { MapView } from '../render/MapView'
import { useEditor } from '../store/editor-store'
import { CommandPalette } from '../ui/CommandPalette'
import { useAutosave, useKeyboard, useUnsavedGuard } from '../ui/hooks'
import { IconClose, IconSearch } from '../ui/icons'
import {
  Coach,
  CanvasEmptyState,
  ShortcutsDialog,
  coachDismissed,
  dismissCoach,
} from '../ui/Onboarding'
import { Browser, Inspector, MapStylePanel, ToolPalette, Toolbar } from '../ui/panels'
import { Button, IconButton, Kbd, Toggle, inputClass } from '../ui/primitives'
import { IconRail, ResizablePanel, useUiPrefs, type Mode } from '../ui/shell'
import { validateProject } from '../domain/validate'

export const Route = createFileRoute('/p/$projectId')({ component: Editor })

function Editor() {
  const { projectId } = Route.useParams()
  const navigate = useNavigate()
  const project = useEditor((s) => s.project)
  const loadIntoStore = useEditor((s) => s.loadProject)
  const closeProject = useEditor((s) => s.closeProject)
  const addImage = useEditor((s) => s.addImage)

  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [exporting, setExporting] = useState(false)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [coachOn, setCoachOn] = useState(() => !coachDismissed())
  const [mode, setMode] = useState<Mode>('network')
  const { prefs, patch } = useUiPrefs()
  const issueCount = project
    ? validateProject(project).filter((i) => i.severity !== 'info').length
    : 0

  useAutosave()
  useKeyboard({
    onSearch: () => setPalette((v) => !v),
    onHelp: () => setHelp((v) => !v),
  })
  useUnsavedGuard()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const p = await loadProject(projectId as ProjectId)
      if (cancelled) return
      if (!p) {
        setStatus('missing')
        return
      }
      loadIntoStore(p)
      setStatus('ready')
    })()
    return () => {
      cancelled = true
      closeProject()
    }
  }, [projectId, loadIntoStore, closeProject])

  const importImages = useCallback(async () => {
    const files = await pickFiles('image/*', true)
    if (files.length === 0) return
    const imported = await importImageFiles(files)
    for (const i of imported) addImage(i.layer)
  }, [addImage])

  if (status === 'loading') {
    return <div className="grid h-full place-items-center text-sm text-slate-500">Opening…</div>
  }

  if (status === 'missing') {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <h1 className="text-xl font-semibold">That project isn’t in this browser</h1>
          <p className="mt-1 text-sm text-slate-500">
            It may have been deleted, or saved in a different browser profile.
          </p>
          <Button variant="primary" size="md" className="mt-4" onClick={() => navigate({ to: '/' })}>
            Back to your maps
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <Toolbar
        onExport={() => setExporting(true)}
        onHelp={() => setHelp(true)}
        theme={prefs.theme}
        density={prefs.density}
        onTheme={(theme) => patch({ theme })}
        onDensity={(density) => patch({ density })}
      />

      <div className="flex min-h-0 flex-1">
        <IconRail mode={mode} onMode={setMode} issueCount={issueCount} />

        <ResizablePanel
          side="left"
          label="Browser"
          width={prefs.browserWidth}
          open={prefs.browserOpen}
          onWidth={(browserWidth) => patch({ browserWidth })}
        >
          <Browser mode={mode} />
        </ResizablePanel>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <MapView />
          <ToolPalette />
          <CanvasEmptyState onImport={importImages} />
          <Coach
            visible={coachOn}
            onDismiss={() => {
              dismissCoach()
              setCoachOn(false)
            }}
          />
          <StatusBar onSearch={() => setPalette(true)} />
        </div>

        <ResizablePanel
          side="right"
          label="Inspector"
          width={prefs.inspectorWidth}
          open={prefs.inspectorOpen}
          onWidth={(inspectorWidth) => patch({ inspectorWidth })}
        >
          {/*
            Two zones, always both present. Selection on top, map style underneath --
            so changing how the map looks no longer requires deselecting first.
          */}
          <div className="border-b border-slate-200 p-3">
            <Inspector />
          </div>
          <div className="p-3">
            <MapStylePanel />
          </div>
        </ResizablePanel>
      </div>

      {exporting && project && <ExportDialog onClose={() => setExporting(false)} />}
      {palette && project && <CommandPalette onClose={() => setPalette(false)} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </div>
  )
}

function StatusBar({ onSearch }: { onSearch: () => void }) {
  const project = useEditor((s) => s.project)
  const space = useEditor((s) => s.space)
  const tool = useEditor((s) => s.tool)
  const activeLineId = useEditor((s) => s.activeLineId)
  const viewport = useEditor((s) => s.viewports[space])
  const setViewport = useEditor((s) => s.setViewport)
  if (!project) return null

  const activeLine = project.lines.find((l) => l.id === activeLineId)

  const say =
    tool === 'line' && activeLine
      ? `Building ${activeLine.name || 'a line'} — click stations in the order they are served`
      : tool === 'station'
        ? 'Click anywhere on the map to drop a station'
        : tool === 'terrain'
          ? 'Click to add points, then press Enter to finish the shape'
          : tool === 'bend'
            ? 'Click a segment to add a corner — Alt+click inserts a station instead'
            : tool === 'pan'
              ? 'Drag to move around'
              : null

  return (
    <div className="z-20 flex shrink-0 items-center gap-3 border-t border-slate-200 bg-white px-3 py-1.5">
      <button
        onClick={() => setViewport(space, { zoom: 1 })}
        title="Reset zoom to 100%"
        className="rounded px-1 font-mono text-[10px] tabular-nums text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      >
        {Math.round(viewport.zoom * 100)}%
      </button>
      <span className="font-mono text-[10px] text-slate-400">
        {project.stations.length} stops · {project.lines.length} lines
      </span>
      {say && <span className="truncate text-[11px] text-slate-600">{say}</span>}

      <button
        onClick={onSearch}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      >
        <IconSearch size={11} />
        Search <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!
  const space = useEditor((s) => s.space)
  const [opts, setOpts] = useState<ExportOptions>(() => defaultExportOptions(space))
  const [scale, setScale] = useState(2)
  const [pdf, setPdf] = useState<PdfOptions>(defaultPdfOptions)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const surface = () =>
    document.querySelector('svg[data-map-surface]') as SVGSVGElement | null

  const withSurface = async (what: string, run: (el: SVGSVGElement) => Promise<void> | void) => {
    const el = surface()
    if (!el) return setNote('Could not find the map surface.')
    setBusy(what)
    setNote(null)
    try {
      await run(el)
    } catch (e) {
      setNote(e instanceof Error ? e.message : `The ${what} export failed.`)
    } finally {
      setBusy(null)
    }
  }

  const doSvg = () =>
    withSurface('SVG', (el) =>
      downloadText(buildSvg(el, project, opts), `${project.name || 'network'}.svg`, 'image/svg+xml'),
    )

  const doPng = () =>
    withSurface('PNG', async (el) => {
      const r = await rasterize(buildSvg(el, project, opts), scale)
      downloadBlob(r.blob, `${project.name || 'network'}@${scale}x.png`)
      setNote(
        r.clampedFrom
          ? `Saved at ${r.width}×${r.height}. ${r.clampedFrom}× would have passed the browser's canvas limit, so the scale was reduced.`
          : `Saved at ${r.width}×${r.height}.`,
      )
    })

  const doPdf = () =>
    withSurface('PDF', async (el) => {
      const r = await buildPdf(buildSvg(el, project, opts), pdf, project.name)
      downloadBlob(r.blob, `${project.name || 'network'}.pdf`)
      setNote(
        `${r.pages} page${r.pages === 1 ? '' : 's'} at ${r.pixelWidth}×${r.pixelHeight}px.` +
          (pdf.tile ? ' Trim the margins and tape the sheets together.' : ''),
      )
    })

  const doInteractive = () =>
    withSurface('interactive page', (el) =>
      downloadText(
        buildInteractiveHtml(buildSvg(el, project, opts), project),
        `${project.name || 'network'}.html`,
        'text/html',
      ),
    )

  const doJson = async (embed: boolean) => {
    setBusy('project file')
    try {
      downloadText(await serializeProject(project, embed), projectFilename(project))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Export</h2>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Saving the {opts.space === 'geo' ? 'map' : 'diagram'} view.
            </p>
          </div>
          <IconButton label="Close" onClick={onClose}>
            <IconClose size={15} />
          </IconButton>
        </div>

        <div className="space-y-1.5 rounded-xl bg-slate-50 p-3">
          <Toggle
            label="Include screenshots"
            checked={opts.includeScreenshots}
            onChange={(v) => setOpts({ ...opts, includeScreenshots: v })}
          />
          <Toggle
            label="Include a legend"
            checked={opts.includeLegend}
            onChange={(v) => setOpts({ ...opts, includeLegend: v })}
          />
          <Toggle
            label="Include a title block"
            checked={opts.includeTitleBlock}
            onChange={(v) => setOpts({ ...opts, includeTitleBlock: v })}
          />
        </div>

        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[12.5px] font-semibold text-slate-900">Vector</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">
              Sharp at any size, with named layers per line. The best option for printing
              or for editing in Inkscape or Illustrator.
            </p>
            <Button variant="primary" size="md" className="mt-2.5 w-full" onClick={doSvg}>
              Download SVG
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[12.5px] font-semibold text-slate-900">Image</p>
            <div className="mt-2 flex gap-2">
              <select
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
                className="w-20 rounded-lg border border-slate-300 px-2 text-sm"
              >
                {[1, 2, 3, 4, 6, 8].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              <Button size="md" className="flex-1" disabled={!!busy} onClick={doPng}>
                {busy === 'PNG' ? 'Rendering…' : 'Download PNG'}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[12.5px] font-semibold text-slate-900">Print</p>
            <div className="mt-2 flex gap-2">
              <select
                value={pdf.pageSizeId}
                onChange={(e) => setPdf({ ...pdf, pageSizeId: e.target.value })}
                className="rounded-lg border border-slate-300 px-2 text-sm"
              >
                {PAGE_SIZES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                value={pdf.dpi}
                onChange={(e) => setPdf({ ...pdf, dpi: Number(e.target.value) })}
                className="rounded-lg border border-slate-300 px-2 text-sm"
              >
                {[110, 150, 200, 300].map((d) => (
                  <option key={d} value={d}>
                    {d} dpi
                  </option>
                ))}
              </select>
              <Button size="md" className="flex-1" disabled={!!busy} onClick={doPdf}>
                {busy === 'PDF' ? 'Building…' : 'PDF'}
              </Button>
            </div>
            <div className="mt-2">
              <Toggle
                label="Tile across several sheets"
                hint="For a poster bigger than one page"
                checked={pdf.tile}
                onChange={(v) => setPdf({ ...pdf, tile: v })}
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[12.5px] font-semibold text-slate-900">Interactive page</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">
              One self-contained HTML file. Click a line to follow it, hover a station to
              see what calls there. Works offline, opens anywhere.
            </p>
            <Button size="md" className="mt-2.5 w-full" disabled={!!busy} onClick={doInteractive}>
              {busy === 'interactive page' ? 'Building…' : 'Download HTML'}
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[12.5px] font-semibold text-slate-900">Back up this project</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">
              A file you can reopen later or move to another machine.
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button className="flex-1" disabled={!!busy} onClick={() => doJson(false)}>
                Project only
              </Button>
              <Button className="flex-1" disabled={!!busy} onClick={() => doJson(true)}>
                With screenshots
              </Button>
            </div>
          </div>
        </div>

        {note && (
          <p className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-[11.5px] leading-relaxed text-slate-700">
            {note}
          </p>
        )}
      </div>
    </div>
  )
}

export { inputClass }
