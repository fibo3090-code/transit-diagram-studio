import { useEffect, useRef } from 'react'

import { saveProject } from '../persistence/idb'
import { useEditor } from '../store/editor-store'

/**
 * Debounced autosave to IndexedDB. Also flushes on tab hide, because a laptop lid
 * closing is the most likely way to lose the last few seconds of work.
 */
export function useAutosave(delayMs = 800) {
  const project = useEditor((s) => s.project)
  const dirty = useEditor((s) => s.dirty)
  const markSaved = useEditor((s) => s.markSaved)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!project || !dirty) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void saveProject(project).then(markSaved).catch(() => {})
    }, delayMs)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [project, dirty, delayMs, markSaved])

  useEffect(() => {
    const flush = () => {
      const { project: p, dirty: d, markSaved: done } = useEditor.getState()
      if (p && d) void saveProject(p).then(done).catch(() => {})
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
    }
  }, [])
}

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * Global keyboard handling.
 *
 * Alt is treated as a live modifier rather than a shortcut: holding it suspends
 * snapping mid-drag, which is the escape hatch that keeps assisted placement from ever
 * being a trap.
 */
export function useKeyboard(opts: { onSearch?: () => void; onHelp?: () => void } = {}) {
  const onSearchRef = useRef(opts.onSearch)
  const onHelpRef = useRef(opts.onHelp)
  onSearchRef.current = opts.onSearch
  onHelpRef.current = opts.onHelp

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useEditor.getState()

      if (e.key === 'Alt') {
        s.setSnapSuspended(true)
        return
      }

      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onSearchRef.current?.()
        return
      }

      if (isTypingTarget(e.target)) return

      // `?` is shift+/ on most layouts, so match the produced character rather than a
      // key code — that keeps it working on layouts where / sits elsewhere.
      if (e.key === '?') {
        e.preventDefault()
        onHelpRef.current?.()
        return
      }

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
        return
      }

      if (mod) return

      switch (e.key) {
        case 'v': s.setTool('select'); break
        case 's': s.setTool('station'); break
        case 'l': s.setTool('line'); break
        case 't': s.setTool('terrain'); break
        case 'b': s.setTool('bend'); break
        case 'h': s.setTool('pan'); break
        case 'f':
          window.dispatchEvent(
            new CustomEvent('tds:fit', {
              detail: s.selection.stations.length > 0 ? 'selection' : 'all',
            }),
          )
          break
        case 'g': s.setSpace(s.space === 'geo' ? 'schematic' : 'geo'); break
        case 'Escape':
          s.clearSelection()
          s.setActiveLine(null)
          s.setTool('select')
          break
        case 'Delete':
        case 'Backspace': {
          // Every selectable thing answers to Delete. Stations and terrain used to be
          // the only two, so a selected line, transfer, image or placement had to be
          // removed from a panel -- which is not where you are looking when you press
          // the key.
          const sel = s.selection
          let did = false
          if (sel.stations.length > 0) {
            s.deleteStations(sel.stations)
            did = true
          }
          if (sel.terrain.length > 0) {
            s.deleteTerrain(sel.terrain)
            did = true
          }
          if (sel.placements.length > 0) {
            s.deletePlacements(sel.placements)
            did = true
          }
          if (sel.images.length > 0) {
            s.deleteImages(sel.images)
            did = true
          }
          for (const id of sel.transfers) {
            s.deleteTransfer(id)
            did = true
          }
          for (const id of sel.lines) {
            s.deleteLine(id)
            did = true
          }
          if (did) e.preventDefault()
          break
        }
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (s.selection.stations.length === 0) return
          e.preventDefault()
          const step = e.shiftKey ? 10 : 1
          const d = {
            x: e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
            y: e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
          }
          s.moveStations(s.selection.stations, d, s.space, {
            coalesceKey: `nudge-${s.selection.stations.join(',')}-${s.space}`,
          })
          break
        }
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') useEditor.getState().setSnapSuspended(false)
    }
    // Alt-Tab away mid-drag would otherwise leave snapping stuck off.
    const onBlur = () => useEditor.getState().setSnapSuspended(false)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}

/** Warn before leaving with unsaved changes that autosave has not flushed yet. */
export function useUnsavedGuard() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
}
