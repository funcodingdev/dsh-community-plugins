/**
 * Registry access backed by dsh-plugin-hub's public pluginhub API. The
 * remote contract is paginated; this module assembles the complete catalog
 * for the host's install/update safety checks and revalidates one plugin
 * through the detail endpoint immediately before installation.
 */

import { configuredProxy, pluginHubFetch } from './net.ts'
import { catalogFromPackage } from './catalog-npm.ts'
import { activeRegion, routesFor, type CatalogSource, type Region } from './regions.ts'

export interface RegistryPlugin {
  name: string
  owner: string
  url: string
  /** One legacy category id or several category ids. */
  category: string | string[]
  description: Record<string, string>
  npm?: string | null
  tarball?: string | null
  stars?: number | null
  /**
   * npm downloads in the last 30 days, when the entry has a published
   * package. `null`/absent means "no npm package" — a coverage gap, not a
   * zero — so sorting must not read it as "less popular than 0".
   */
  downloads?: number | null
  install: string
  added: string
  /** Public pluginhub validation metadata. */
  isVerified?: boolean
  installable?: boolean
  validationStatus?: 'pending' | 'verified' | 'build_required' | 'invalid'
  validationReason?: string
  requiresBuildAuthorization?: boolean
  updatedAt?: string
  /**
   * Catalog-side deprecation flags (#60): supplied by dsh-plugin-hub,
   * absent for every normal entry — the pluginhub only consumes them, so a
   * catalog without the fields behaves exactly as before.
   */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
}

/**
 * Category ids for one catalog entry, de-duplicated in declaration order.
 *
 * Catalog JSON is an external input, so malformed array members are omitted
 * here and an entry with no usable category is rejected by `asRegistry`.
 */
export function pluginCategories(plugin: Pick<RegistryPlugin, 'category'>): string[] {
  const values: unknown[] = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
  const categories: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    categories.push(value)
  }
  return categories
}

export interface Registry {
  name?: string
  url?: string
  source?: string
  updated: string
  count: number
  categories: Record<string, Record<string, string>>
  sorts?: Record<string, Record<string, string>>
  plugins: RegistryPlugin[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface PluginHubPagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasMore: boolean
}

interface PluginHubPage {
  name: string
  url: string
  source: string
  updated: string
  count: number
  categories: Registry['categories']
  sorts: NonNullable<Registry['sorts']>
  pagination: PluginHubPagination
  plugins: RegistryPlugin[]
}

const PLUGINHUB_PAGE_SIZE = 48
const PLUGINHUB_PATHS = new Set(['/plugins.json', '/api/marketplace/plugins'])
const PLUGINHUB_CATEGORY_IDS = new Set(['interface', 'development', 'automation', 'knowledge', 'agent'])
const PLUGINHUB_SORT_IDS = ['recommended', 'updated', 'stars'] as const
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/

function pluginHubListUrl(sourceUrl: string, page: number): string | null {
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    return null
  }
  if (!PLUGINHUB_PATHS.has(url.pathname.replace(/\/$/, ''))) return null
  url.searchParams.set('category', 'all')
  url.searchParams.set('sort', 'recommended')
  url.searchParams.set('verifiedOnly', 'false')
  url.searchParams.set('page', String(page))
  url.searchParams.set('pageSize', String(PLUGINHUB_PAGE_SIZE))
  url.searchParams.delete('limit')
  url.searchParams.delete('q')
  return url.toString()
}

function pluginHubDetailUrl(sourceUrl: string, repositoryUrl: string): string | null {
  let source: URL
  let repository: URL
  try {
    source = new URL(sourceUrl)
    repository = new URL(repositoryUrl)
  } catch {
    return null
  }
  if (!PLUGINHUB_PATHS.has(source.pathname.replace(/\/$/, ''))) return null
  if (repository.protocol !== 'https:' || repository.hostname !== 'github.com') return null
  const segments = repository.pathname.split('/').filter(segment => segment !== '')
  if (segments.length !== 2 || !segments.every(segment => REPOSITORY_SEGMENT.test(segment))) return null
  source.pathname = `/api/marketplace/plugins/${encodeURIComponent(segments[0]!)}/${encodeURIComponent(segments[1]!)}`
  source.search = ''
  return source.toString()
}

function pluginHubInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`pluginhub ${label} is invalid`)
  }
  return value
}

function pluginHubPlugin(value: unknown, index: number): RegistryPlugin {
  if (!isRecord(value)) throw new Error(`pluginhub plugin ${String(index)} is not an object`)
  const required = (key: string): string => {
    const field = value[key]
    if (typeof field !== 'string') throw new Error(`pluginhub plugin ${String(index)} has invalid ${key}`)
    return field
  }
  const name = required('name')
  const owner = required('owner')
  const url = required('url')
  if (name === '' || !REPOSITORY_SEGMENT.test(owner)) {
    throw new Error(`pluginhub plugin ${String(index)} has an invalid identity`)
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error(`pluginhub plugin ${String(index)} has an invalid repository URL`)
  }
  const urlSegments = parsedUrl.pathname.split('/').filter(segment => segment !== '')
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com' || urlSegments.length !== 2
      || urlSegments[0]!.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`pluginhub plugin ${String(index)} has an invalid repository URL`)
  }
  if (!isRecord(value.description)) throw new Error(`pluginhub plugin ${String(index)} has invalid description`)
  const description = Object.fromEntries(
    Object.entries(value.description).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  const stars = pluginHubInteger(value.stars, `plugin ${String(index)} stars`)
  const category = required('category')
  if (!PLUGINHUB_CATEGORY_IDS.has(category)) {
    throw new Error(`pluginhub plugin ${String(index)} has invalid category`)
  }
  const validationStatus = value.validationStatus
  if (validationStatus !== 'pending' && validationStatus !== 'verified'
      && validationStatus !== 'build_required' && validationStatus !== 'invalid') {
    throw new Error(`pluginhub plugin ${String(index)} has invalid validationStatus`)
  }
  if (typeof value.isVerified !== 'boolean' || typeof value.installable !== 'boolean'
      || typeof value.requiresBuildAuthorization !== 'boolean') {
    throw new Error(`pluginhub plugin ${String(index)} has invalid validation metadata`)
  }
  return {
    name,
    owner,
    url,
    category,
    description,
    npm: null,
    tarball: null,
    stars,
    downloads: null,
    install: required('install'),
    added: required('added'),
    isVerified: value.isVerified,
    installable: value.installable,
    validationStatus,
    validationReason: required('validationReason'),
    requiresBuildAuthorization: value.requiresBuildAuthorization,
    updatedAt: required('updatedAt'),
  }
}

function pluginHubPage(value: unknown): PluginHubPage | null {
  if (!isRecord(value) || value.name !== 'dsh-plugin-hub' || !isRecord(value.pagination)) return null
  if (!Array.isArray(value.plugins)) throw new Error('pluginhub plugins is not an array')
  if (!isRecord(value.categories) || !isRecord(value.sorts)) {
    throw new Error('pluginhub taxonomy is invalid')
  }
  for (const category of ['all', ...PLUGINHUB_CATEGORY_IDS]) {
    if (!isRecord(value.categories[category])) throw new Error(`pluginhub category ${category} is missing`)
  }
  for (const sort of PLUGINHUB_SORT_IDS) {
    if (!isRecord(value.sorts[sort])) throw new Error(`pluginhub sort ${sort} is missing`)
  }
  const pagination: PluginHubPagination = {
    page: pluginHubInteger(value.pagination.page, 'page'),
    pageSize: pluginHubInteger(value.pagination.pageSize, 'pageSize'),
    total: pluginHubInteger(value.pagination.total, 'total'),
    totalPages: pluginHubInteger(value.pagination.totalPages, 'totalPages'),
    hasMore: value.pagination.hasMore === true,
  }
  if (pagination.page < 1 || pagination.pageSize < 1 || pagination.pageSize > PLUGINHUB_PAGE_SIZE) {
    throw new Error('pluginhub pagination is out of bounds')
  }
  return {
    name: value.name,
    url: typeof value.url === 'string' ? value.url : '',
    source: typeof value.source === 'string' ? value.source : '',
    updated: typeof value.updated === 'string' ? value.updated : '',
    count: pluginHubInteger(value.count, 'count'),
    categories: value.categories as PluginHubPage['categories'],
    sorts: value.sorts as PluginHubPage['sorts'],
    pagination,
    plugins: value.plugins.map(pluginHubPlugin),
  }
}

async function completePluginHubRegistry(sourceUrl: string, firstValue: unknown, signal: AbortSignal): Promise<Registry | null> {
  const first = pluginHubPage(firstValue)
  if (first === null) return null
  if (first.pagination.page !== 1) throw new Error('pluginhub first response is not page 1')
  const empty = first.pagination.total === 0 && first.count === 0 && first.plugins.length === 0
    && first.pagination.totalPages === 0 && !first.pagination.hasMore
  if (!empty && (first.pagination.totalPages < 1 || first.pagination.total < 1 || first.plugins.length === 0)) {
    throw new Error('the pluginhub pagination is inconsistent')
  }
  const pages: PluginHubPage[] = new Array(Math.max(1, first.pagination.totalPages))
  pages[0] = first
  let nextPage = 2
  const workerCount = Math.min(6, Math.max(0, first.pagination.totalPages - 1))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextPage <= first.pagination.totalPages) {
      const pageNumber = nextPage++
      const pageUrl = pluginHubListUrl(sourceUrl, pageNumber)
      if (pageUrl === null) throw new Error('pluginhub pagination URL is unavailable')
      signal.throwIfAborted()
      const response = await pluginHubFetch(pageUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) })
      if (!response.ok) throw new Error(`pluginhub page ${String(pageNumber)}: HTTP ${String(response.status)}`)
      const page = pluginHubPage(await response.json())
      if (page === null || page.pagination.page !== pageNumber
          || page.pagination.total !== first.pagination.total
          || page.pagination.totalPages !== first.pagination.totalPages) {
        throw new Error(`pluginhub page ${String(pageNumber)} is inconsistent`)
      }
      pages[pageNumber - 1] = page
    }
  }))
  const plugins = pages.flatMap(page => page.plugins)
  if (plugins.length !== first.pagination.total) {
    throw new Error(`pluginhub pagination returned ${String(plugins.length)} of ${String(first.pagination.total)} plugins`)
  }
  return {
    name: first.name,
    url: first.url,
    source: first.source,
    updated: first.updated,
    count: first.count,
    categories: first.categories,
    sorts: first.sorts,
    plugins,
  }
}

/**
 * Where the curated list comes from now lives in the region routing table
 * (src/regions.ts), because it is one of several addresses that move
 * together when a user changes download region.
 *
 * `DSH_PLUGINHUB_REGISTRY_URL` keeps its meaning there, unchanged: overridable
 * through the process environment ONLY — the layer-3 e2e points it at a
 * local fixture catalog so the install route can be driven end to end
 * without publishing anything.
 *
 * This does not weaken the install route's registry check. That check exists
 * to stop a malicious PAGE from POSTing an arbitrary source at the local
 * server; a page cannot set environment variables, and anyone who can set
 * this process's environment already controls the process. What the override
 * changes is WHICH list is curated, never WHETHER the check runs.
 */

const FETCH_TIMEOUT_MS = 15_000
export const CATALOG_TTL_MS = 5 * 60_000

interface ServedCatalog {
  key: string
  etag: string | null
  modified: string | null
  version: string | null
  data: Registry
}

/** Identity of a catalog source, for scoping the validator to its origin. */
function sourceKey(source: CatalogSource): string {
  return source.kind === 'npm' ? `npm:${source.registry}/${source.pkg}` : `url:${source.url}`
}

/** A parsed catalog, or a thrown explanation of why it is not one. */
function asRegistry(value: unknown): Registry {
  if (!isRecord(value)) throw new Error('the catalog is not an object')
  const data = value as unknown as Registry
  if (!Array.isArray(data.plugins) || data.plugins.length === 0) throw new Error('the catalog came back empty')
  const plugins = data.plugins.map((plugin, index) => {
    const category = pluginCategories(plugin)
    if (category.length === 0) throw new Error(`catalog plugin ${String(index)} carries no usable category`)
    return { ...plugin, category }
  })
  return { ...data, plugins }
}

/** Fetch and validate a complete remote catalog; never substitute bundled data. */
async function fetchRegistry(
  sources: CatalogSource[],
  served: ServedCatalog | null,
  signal: AbortSignal,
): Promise<ServedCatalog> {
  const started = Date.now()
  let last: unknown
  let attempts = 0
  // Sources in order, each a fallback for the one before it. The catalog is
  // the FIRST request the pluginhub makes, so a mirror that has gone down must
  // mean a slow pluginhub rather than an empty one — the list ends at the
  // address that has always worked.
  for (const source of sources) {
    const key = sourceKey(source)
    // Two attempts each. A catalog fetch crossing a long, lossy path fails
    // transiently often enough that one retry is worth more than the second
    // or two it costs — and with nothing behind this call any more, a
    // transient failure is a pluginhub with no plugins in it.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      attempts += 1
      try {
        // A validator only ever goes back to the source that issued it.
        // Carried across a region switch it could earn a "not modified" from
        // an origin whose body we have never seen.
        const reusable = served?.key === key ? served : null
        if (source.kind === 'npm') {
          const { version, data } = await catalogFromPackage(
            source.registry, source.pkg, reusable?.version ?? undefined, 'package/plugins.json', signal,
          )
          // `data === null` means the published version is the one in hand.
          if (data === null && reusable !== null) return reusable
          if (data === null) throw new Error('the catalog package reported no change with nothing to reuse')
          const parsed = asRegistry(data)
          return { key, etag: null, modified: null, version, data: parsed }
        }
        // ETag first: it is exact, while a date has one-second resolution and
        // a catalog republished twice within the same second would validate
        // as unchanged. Only one is sent — an origin given both must satisfy
        // both, which turns a weak ETag match into an unnecessary 200.
        const headers: Record<string, string> = {}
        if (reusable?.etag != null) headers['if-none-match'] = reusable.etag
        else if (reusable?.modified != null) headers['if-modified-since'] = reusable.modified

        const requestUrl = pluginHubListUrl(source.url, 1) ?? source.url
        const res = await pluginHubFetch(requestUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]), headers })
        if (res.status === 304) {
          // Only reachable when we sent a validator, so `reusable` is present.
          // Guarded anyway: answering a 304 with nothing to reuse would
          // otherwise surface as a confusing parse error on an empty body.
          if (reusable === null) throw new Error('the catalog answered "not modified" with nothing to revalidate')
          return reusable
        }
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
        const value = await res.json()
        const pluginHubUrl = pluginHubListUrl(source.url, 1) !== null
        const pluginhub = await completePluginHubRegistry(source.url, value, signal)
        if (pluginHubUrl && pluginhub === null) {
          throw new Error('the pluginhub response does not match the public protocol')
        }
        const data = pluginhub ?? asRegistry(value)
        return {
          key, etag: res.headers.get('etag'), modified: res.headers.get('last-modified'), version: null, data,
        }
      } catch (error) {
        signal.throwIfAborted()
        last = error
      }
    }
  }
  throw new Error(describeFetchFailure(last, Date.now() - started, attempts))
}

/** One cache per plugin mount. Disposal cancels requests and releases all catalog data. */
export function createRegistryClient(currentRegion: () => Region = activeRegion) {
  const cache = new Map<string, {
    served: ServedCatalog | null
    checkedAt: number
    pending: Promise<Registry> | null
  }>()
  let lifetime = new AbortController()
  let disposed = false

  function assertActive(): void {
    if (disposed) throw new Error('the catalog client has been disposed')
  }

  function forgetCatalog(): void {
    lifetime.abort()
    lifetime = new AbortController()
    cache.clear()
  }

  async function loadRegistry(
    region: Region = currentRegion(),
    options: { force?: boolean } = {},
  ): Promise<Registry> {
    assertActive()
    const sources = routesFor(region).catalog
    const key = JSON.stringify(sources.map(sourceKey))
    let entry = cache.get(key)
    if (entry === undefined) {
      entry = { served: null, checkedAt: 0, pending: null }
      cache.set(key, entry)
    }
    if (entry.pending !== null) return entry.pending
    if (!options.force && entry.served !== null && Date.now() - entry.checkedAt < CATALOG_TTL_MS) {
      return entry.served.data
    }
    const state = entry
    const signal = lifetime.signal
    const pending = fetchRegistry(sources, state.served, signal).then(served => {
      // A response from an unloaded mount or an old region must not refill the cache.
      signal.throwIfAborted()
      state.served = served
      state.checkedAt = Date.now()
      return served.data
    }).finally(() => { state.pending = null })
    state.pending = pending
    return pending
  }

  /**
   * Revalidate one repository through the public detail endpoint immediately
   * before installation. Custom legacy catalogs have no corresponding detail
   * route, so they keep the existing complete-catalog lookup.
   */
  async function loadRegistryPlugin(
    repositoryUrl: string,
    region: Region = currentRegion(),
  ): Promise<RegistryPlugin | undefined> {
    assertActive()
    const signal = lifetime.signal
    const pluginHubSource = routesFor(region).catalog.find(
      (source): source is Extract<CatalogSource, { kind: 'url' }> =>
        source.kind === 'url' && pluginHubDetailUrl(source.url, repositoryUrl) !== null,
    )
    if (pluginHubSource === undefined) {
      const registry = await loadRegistry(region, { force: true })
      return registry.plugins.find(plugin => plugin.url.toLowerCase() === repositoryUrl.toLowerCase())
    }
    const detailUrl = pluginHubDetailUrl(pluginHubSource.url, repositoryUrl)!
    const response = await pluginHubFetch(detailUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`pluginhub plugin lookup: HTTP ${String(response.status)}`)
    const page = pluginHubPage(await response.json())
    if (page === null || page.plugins.length !== 1) throw new Error('pluginhub plugin lookup returned invalid data')
    signal.throwIfAborted()
    const plugin = page.plugins[0]!
    if (plugin.url.toLowerCase() !== repositoryUrl.toLowerCase()) {
      throw new Error('pluginhub plugin lookup returned a different repository')
    }
    return plugin
  }

  return {
    loadRegistry,
    loadRegistryPlugin,
    forgetCatalog,
    dispose(): void {
      disposed = true
      forgetCatalog()
    },
  }
}

// Standalone callers can use the same API; mounted plugins own a separate client.
export const { loadRegistry, loadRegistryPlugin, forgetCatalog } = createRegistryClient()

/**
 * A catalog failure with the facts needed to classify it, in the message
 * itself.
 *
 * The pluginhub shows this string and the log export carries it, so it is the
 * whole of what a bug report will contain. "The operation was aborted due to
 * timeout" alone cannot distinguish a slow link from a blocked one from a
 * proxy this process cannot use — and Node's `fetch` ignores HTTP_PROXY
 * entirely (measured on Node 25), so a machine whose only route out is a
 * proxy fails here every time while every other tool on it works.
 */
export function describeFetchFailure(error: unknown, elapsedMs: number, attempts = 2): string {
  const reason = error instanceof Error ? error.message : String(error)
  const proxy = configuredProxy()
  const parts = [`${reason} (${String(Math.round(elapsedMs / 1000))}s, ${String(attempts)} attempts)`]
  if (proxy !== null) {
    parts.push(`tried through the configured proxy ${proxy.replace(/\/\/[^@]*@/u, '//***@')}`)
  }
  return parts.join(' · ')
}
