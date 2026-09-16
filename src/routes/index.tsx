import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

import { createEmptyProject } from '../domain/defaults'
import { newProjectId } from '../domain/ids'
import { createSampleProject } from '../domain/sample'
import type { Project, ProjectId } from '../domain/types'
import { parseProjectFile, pickFiles } from '../persistence/files'
import {
  deleteProject,
  listProjects,
  loadProject,
  requestPersistence,
  saveProject,
  storageEstimate,
  type ProjectSummary,
} from '../persistence/idb'
import { IconDiagram, IconPlus, IconTrash } from '../ui/icons'
import { Button, IconButton } from '../ui/primitives'

export const Route = createFileRoute('/')({ component: Library })

const fmtDate = (t: number) => {
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const fmtBytes = (n: number) => {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function Library() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects())
      setStorage(await storageEstimate())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read local storage.')
      setProjects([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    void requestPersistence()
  }, [refresh])

  const open = (id: ProjectId) => navigate({ to: '/p/$projectId', params: { projectId: id } })

  const create = async (project: Project) => {
    setBusy(true)
    try {
      await saveProject(project)
      open(project.id)
    } finally {
      setBusy(false)
    }
  }

  const importFile = async () => {
    setError(null)
    const [file] = await pickFiles('.json,application/json')
    if (!file) return
    setBusy(true)
    try {
      const { project, missingImages } = await parseProjectFile(await file.text())
      const copy: Project = { ...project, id: newProjectId(), updatedAt: Date.now() }
      await saveProject(copy)
      if (missingImages > 0) {
        setError(
          `Opened, but ${missingImages} screenshot${missingImages === 1 ? '' : 's'} were not in the file. Re-import them from the Layers panel.`,
        )
      }
      open(copy.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that project file.')
    } finally {
      setBusy(false)
    }
  }

  const duplicate = async (id: ProjectId) => {
    const src = await loadProject(id)
    if (!src) return
    await saveProject({
      ...src,
      id: newProjectId(),
      name: `${src.name} copy`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await refresh()
  }

  const remove = async (summary: ProjectSummary) => {
    if (!window.confirm(`Delete “${summary.name}” and its screenshots? This cannot be undone.`)) {
      return
    }
    await deleteProject(summary.id)
    await refresh()
  }

  const hasProjects = projects !== null && projects.length > 0

  return (
    <div className="min-h-full bg-slate-50">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <header className="mb-10">
          <h1 className="text-[32px] font-semibold leading-tight tracking-tight text-slate-900">
            Transit Diagram Studio
          </h1>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-slate-600">
            Turn screenshots of your game map into a clean, printable transit diagram.
            Everything stays on this computer — no account, no server, nothing to pay for.
          </p>
        </header>

        {!hasProjects && projects !== null && (
          <section className="mb-8 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="text-sm font-semibold text-slate-900">New here?</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-slate-500">
                Open the example network first. It is a finished map you can pull apart —
                the fastest way to see what the tool does before you start your own.
              </p>
            </div>
            <button
              onClick={() => create(createSampleProject())}
              disabled={busy}
              className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
                <IconDiagram size={19} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-slate-900">
                  Open the example map
                </span>
                <span className="mt-0.5 block text-[12px] text-slate-500">
                  Five lines, a branching tram, a river and a handful of interchanges
                </span>
              </span>
              <span className="shrink-0 text-slate-300">→</span>
            </button>
          </section>
        )}

        <div className="mb-8 flex flex-wrap gap-2">
          <Button variant="primary" size="md" disabled={busy} onClick={() => create(createEmptyProject())}>
            <IconPlus size={15} />
            New map
          </Button>
          <Button size="md" disabled={busy} onClick={importFile}>
            Open a project file
          </Button>
          {hasProjects && (
            <Button size="md" variant="ghost" disabled={busy} onClick={() => create(createSampleProject())}>
              Load the example
            </Button>
          )}
        </div>

        {error && (
          <p className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
            {error}
          </p>
        )}

        {projects === null ? (
          <p className="text-sm text-slate-400">Reading local storage…</p>
        ) : projects.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center text-[13px] text-slate-500">
            Your maps will appear here once you make one.
          </p>
        ) : (
          <>
            <p className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Your maps
            </p>
            <ul className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              {projects.map((p, i) => (
                <li
                  key={p.id}
                  className={`group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50 ${
                    i > 0 ? 'border-t border-slate-100' : ''
                  }`}
                >
                  <button onClick={() => open(p.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[13.5px] font-medium text-slate-900">
                      {p.name || 'Untitled'}
                    </span>
                    <span className="mt-0.5 block font-mono text-[10.5px] text-slate-400">
                      {p.stationCount} stop{p.stationCount === 1 ? '' : 's'} · {p.lineCount} line
                      {p.lineCount === 1 ? '' : 's'} · edited {fmtDate(p.updatedAt)}
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <Button variant="ghost" onClick={() => duplicate(p.id)}>
                      Duplicate
                    </Button>
                    <IconButton label="Delete map" variant="danger" onClick={() => remove(p)}>
                      <IconTrash size={14} />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {storage && storage.quota > 0 && (
          <p className="mt-8 font-mono text-[10.5px] text-slate-400">
            Using {fmtBytes(storage.usage)} of roughly {fmtBytes(storage.quota)} this browser
            allows. Export a project file to move a map elsewhere.
          </p>
        )}
      </div>
    </div>
  )
}
