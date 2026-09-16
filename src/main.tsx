import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { applyStoredTheme } from './ui/shell'
import './styles.css'

// Applied before React mounts, and before the first paint.
//
// Doing it inside the editor meant the theme only existed on that one route -- the
// project list stayed light whatever you had chosen -- and any route that did apply it
// flashed the light palette for a frame first.
applyStoredTheme()

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: false,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('app')!
if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />)
}
