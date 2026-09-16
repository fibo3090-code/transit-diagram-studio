/**
 * IndexedDB persistence.
 *
 * Two stores: `projects` holds the JSON, `blobs` holds the screenshot bytes keyed by
 * `ImageLayer.blobKey`. Keeping the bytes out of the project record is what lets the
 * project JSON stay small enough to autosave on every change.
 */

import { normalizeProject } from '../domain/migrate'
import type { Project, ProjectId } from '../domain/types'

const DB_NAME = 'transit-diagram-studio'
const DB_VERSION = 1
const PROJECTS = 'projects'
const BLOBS = 'blobs'

export interface ProjectSummary {
  id: ProjectId
  name: string
  createdAt: number
  updatedAt: number
  stationCount: number
  lineCount: number
}

interface ProjectRecord extends ProjectSummary {
  project: Project
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(PROJECTS)) {
        const store = db.createObjectStore(PROJECTS, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Could not open the local database'))
  })
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('Local database write failed'))
      }),
  )
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const summarize = (p: Project): ProjectSummary => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  stationCount: p.stations.length,
  lineCount: p.lines.length,
})

export async function saveProject(project: Project): Promise<void> {
  const record: ProjectRecord = { ...summarize(project), project }
  await tx(PROJECTS, 'readwrite', (s) => s.put(record))
}

export async function loadProject(id: ProjectId): Promise<Project | null> {
  const rec = await tx<ProjectRecord | undefined>(PROJECTS, 'readonly', (s) => s.get(id))
  // Normalising on the way out means a project saved by an older build gains any
  // settings added since, instead of silently reading them as false.
  return rec?.project ? normalizeProject(rec.project) : null
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await tx<ProjectRecord[]>(PROJECTS, 'readonly', (s) => s.getAll())
  return all
    .map(({ project: _p, ...summary }) => summary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteProject(id: ProjectId): Promise<void> {
  const project = await loadProject(id)
  await tx(PROJECTS, 'readwrite', (s) => s.delete(id))
  // Take the screenshots with it; nothing else can reference them.
  if (project) {
    await Promise.all(project.images.map((i) => deleteBlob(i.blobKey).catch(() => {})))
  }
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await tx(BLOBS, 'readwrite', (s) => s.put(blob, key))
}

export async function getBlob(key: string): Promise<Blob | null> {
  const b = await tx<Blob | undefined>(BLOBS, 'readonly', (s) => s.get(key))
  return b ?? null
}

export async function deleteBlob(key: string): Promise<void> {
  await tx(BLOBS, 'readwrite', (s) => s.delete(key))
}

// ---------------------------------------------------------------------------
// Object-URL cache
// ---------------------------------------------------------------------------

const urlCache = new Map<string, string>()

/** Object URL for a stored blob, created once and reused for the session. */
export async function blobUrl(key: string): Promise<string | null> {
  const cached = urlCache.get(key)
  if (cached) return cached
  const blob = await getBlob(key)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(key, url)
  return url
}

export function releaseBlobUrl(key: string): void {
  const url = urlCache.get(key)
  if (url) {
    URL.revokeObjectURL(url)
    urlCache.delete(key)
  }
}

export function releaseAllBlobUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
}

// ---------------------------------------------------------------------------
// Storage pressure
// ---------------------------------------------------------------------------

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

/**
 * Ask the browser to keep this origin's data. Without it, a large project can be
 * evicted under storage pressure, which for a local-only app means losing work.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted?.()) return true
  return navigator.storage.persist()
}
