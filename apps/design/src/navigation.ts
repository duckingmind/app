export const DESIGN_MODULES = ['product', 'detail', 'tryon', 'clone'] as const

export type DesignModule = (typeof DESIGN_MODULES)[number]
export type DesignView = 'studio' | 'works'

export type DesignRoute = {
  module: DesignModule
  view: DesignView
}

export const DEFAULT_DESIGN_ROUTE: DesignRoute = { module: 'product', view: 'studio' }

function isDesignModule(value: string | null): value is DesignModule {
  return DESIGN_MODULES.includes(value as DesignModule)
}

export function readDesignRoute(location: Pick<Location, 'search'>): DesignRoute {
  const params = new URLSearchParams(location.search)
  return {
    module: isDesignModule(params.get('module')) ? params.get('module') as DesignModule : DEFAULT_DESIGN_ROUTE.module,
    view: params.get('view') === 'works' ? 'works' : DEFAULT_DESIGN_ROUTE.view,
  }
}

export function sameDesignRoute(a: DesignRoute, b: DesignRoute) {
  return a.module === b.module && a.view === b.view
}

/** Build a route URL while retaining host/Vite query parameters. */
export function designRouteURL(route: DesignRoute, currentURL: URL) {
  const next = new URL(currentURL.href)
  if (route.view === 'works') next.searchParams.set('view', 'works')
  else next.searchParams.delete('view')
  if (route.module === DEFAULT_DESIGN_ROUTE.module) next.searchParams.delete('module')
  else next.searchParams.set('module', route.module)
  return next
}

/**
 * Update the browser URL without a full navigation. The app uses query
 * parameters instead of pathname routes so packaged apps and Vite previews
 * work without server-side fallback configuration.
 */
export function commitDesignRoute(route: DesignRoute, replace = false) {
  if (typeof window === 'undefined') return
  const next = designRouteURL(route, new URL(window.location.href))
  const nextURL = `${next.pathname}${next.search}${next.hash}`
  const currentURL = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextURL === currentURL) return
  const method = replace ? 'replaceState' : 'pushState'
  window.history[method]({ ...window.history.state, designRoute: route }, '', nextURL)
}
