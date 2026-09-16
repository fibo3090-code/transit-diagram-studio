import { Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <div className="h-full text-slate-900">
      <Outlet />
    </div>
  ),
  notFoundComponent: () => (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold">Nothing here</h1>
        <a href="/" className="mt-2 inline-block text-blue-600 underline">
          Back to your projects
        </a>
      </div>
    </div>
  ),
})
