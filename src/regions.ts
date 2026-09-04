/**
 * Download regions: which route the pluginhub's own network requests take.
 *
 * Almost every external request the pluginhub makes lands on npm's registry or
 * on GitHub — the plugin catalog, update checks, package downloads, plugin
 * tarballs, author avatars, README screenshots. From mainland China all of
 * those are slow at once, which is why this is ONE setting rather than a
 * row of them: "npm mirror", "GitHub proxy" and "image proxy" are three
 * spellings of a single question the user is actually being asked, which is
 * where they are.
 *
 * The routing table is the single source of truth. Every consumer asks it
 * rather than reaching for a hardcoded host, so adding a region is a table
 * entry instead of a search across six modules.
 *
 * Each route has an environment escape hatch, following `DSH_PLUGINHUB_REGISTRY_URL`
 * (src/registry.ts). The China route leans on a free public proxy for the
 * GitHub half; those come and go, and a user whose proxy has died needs a
 * way out that is not "wait for the next release".
 */

/** A region the pluginhub can download from. */
export type Region = 'global' | 'china'

/** Every region a user may pick. */
export const REGIONS: readonly Region[] = ['global', 'china']

/** Narrow an untrusted value to a Region, or null. */
export function asRegion(value: unknown): Region | null {
  return value === 'global' || value === 'china' ? value : null
}

/**
 * The npm registry the pluginhub and pnpm read, no trailing slash.
 *
 * Exported because callers need to tell "this region uses the default" from
 * "this region names a mirror" — the difference between leaving a spawned
 * pnpm's registry alone and setting it.
 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_CHINA = 'https://mirrors.cloud.tencent.com/npm'

/**
 * Prefix proxy for github.com-family URLs, no trailing slash.
 *
 * It serves GitHub raw content, API requests, and commit-pinned codeload
 * tarballs. The China catalog route uses it first, then falls back to the
 * official raw URL.
 *
 * What this proxy accepts is a list of GitHub SERVICES, not a hostname test.
 * The previous note here said it "refuses anything that is not a github.com
 * hostname", which #460 by @Homplex measured as wrong in both directions —
 * re-measured 2026-09-01:
 *
 *   https://raw.githubusercontent.com/…   200   ← not a github.com hostname
 *   https://github.com/owner/repo         403   ← is one
 *   https://example.com/                  403
 *
 * So a plain repository page is refused while raw content is served. Do not
 * reason about this proxy from the hostname; check the specific service, and
 * re-measure rather than infer, because the policy is the operator's and can
 * change under us. That fragility is the substance of #460's actual request
 * (a mirror list and a visible setting), which is tracked separately.
 */
const GITHUB_PROXY_CHINA = 'https://gh-proxy.com'

/**
 * The catalog's stable public API. It keeps the Awesome DSH Plugin registry
 * fields and adds bounded pagination plus install-validation metadata.
 */
export const PLUGINHUB_CATALOG_URL = 'https://dshpluginhub.com/plugins.json'

/**
 * One place the catalog can be read from.
 *
 * URL is the active transport. The npm variant remains in the type so custom
 * deployments can use an npm-carried catalog without weakening validation.
 */
export type CatalogSource =
  | { kind: 'url'; url: string }
  | { kind: 'npm'; registry: string; pkg: string }

/** Where one region sends each kind of request. `null` means "go direct". */
export interface RegionRoutes {
  /** npm registry base, no trailing slash. */
  npmRegistry: string
  /** Prefix proxy for github.com-family URLs, or null to go direct. */
  githubProxy: string | null
  /**
   * Where to look for the catalog, in order. Later entries are fallbacks.
   *
   * The catalog is the FIRST request the pluginhub makes, so a mirror that has
   * gone down must mean a slow pluginhub rather than an empty one — every
   * region ends its list at an address that has always worked.
   */
  catalog: CatalogSource[]
}

const ROUTES: Record<Region, RegionRoutes> = {
  global: {
    npmRegistry: DEFAULT_NPM_REGISTRY,
    githubProxy: null,
    catalog: [{ kind: 'url', url: PLUGINHUB_CATALOG_URL }],
  },
  china: {
    npmRegistry: NPM_CHINA,
    githubProxy: GITHUB_PROXY_CHINA,
    // dshpluginhub.com is already a Cloudflare-backed public API, not a
    // GitHub service accepted by the prefix proxy above. Both regions read
    // the same canonical catalog while GitHub assets still use the mirror.
    catalog: [{ kind: 'url', url: PLUGINHUB_CATALOG_URL }],
  },
}

/** Read an environment override, treating blank as unset. */
function override(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]
  return raw !== undefined && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : null
}

/**
 * The routes for a region, with environment overrides applied.
 *
 * Overrides win over the table because they are the user's statement about
 * their own network, and they are the way out when a public proxy dies.
 *
 * `DSH_PLUGINHUB_REGISTRY_URL` keeps its existing meaning — the catalog URL — and
 * when set it REPLACES the source list rather than heading it: someone
 * pointing the pluginhub at their own catalog does not want it quietly
 * reverting to ours.
 */
export function routesFor(region: Region, env: NodeJS.ProcessEnv = process.env): RegionRoutes {
  const base = ROUTES[region]
  const npmMirror = override(env, 'DSH_PLUGINHUB_NPM_MIRROR')
  const githubProxy = override(env, 'DSH_PLUGINHUB_GITHUB_PROXY')
  const catalog = override(env, 'DSH_PLUGINHUB_REGISTRY_URL')
  const registry = npmMirror ?? base.npmRegistry
  return {
    npmRegistry: registry,
    githubProxy: githubProxy ?? base.githubProxy,
    // A named catalog REPLACES the list rather than joining it. Someone
    // pointing the pluginhub at their own catalog does not want it quietly
    // reverting to ours when theirs is briefly unreachable — that is how a
    // fixture-backed test ends up asserting against the live registry.
    catalog: catalog !== null
      ? [{ kind: 'url', url: catalog }]
      // Rebuilt against the resolved registry, so an npm override moves the
      // catalog to the same mirror it moved everything else to.
      : base.catalog.map(source => (source.kind === 'npm' ? { ...source, registry } : source)),
  }
}

/**
 * The region this process is running under.
 *
 * One piece of module state rather than a parameter threaded through the
 * catalog, update checks and every pnpm spawn: the region
 * is a property of the running pluginhub, not of any single question asked of
 * it, and the call graphs that need it are several frames deep.
 *
 * Consumers that must react to a CHANGE (dropping a cache gathered from the
 * other registry) keep their own setter beside this one; this holds the
 * answer for everyone who only needs to read it.
 */
let active: Region = 'global'

/** The region in force. */
export function activeRegion(): Region {
  return active
}

/** Set the region in force. Callers are responsible for their own caches. */
export function setActiveRegion(region: Region): void {
  active = region
}

/**
 * Wrap a github.com-family URL in a prefix proxy.
 *
 * The proxy takes the full absolute URL as its path (`{proxy}/{url}`) rather
 * than a rewritten hostname, which is what lets one prefix serve api,
 * codeload, raw and the web host without a mapping table per service.
 *
 * @param proxy - the prefix, or null to go direct.
 * @param url - an absolute https URL on a github.com-family host.
 * @returns the proxied URL, or `url` unchanged when there is no proxy.
 */
export function throughProxy(proxy: string | null, url: string): string {
  return proxy === null ? url : `${proxy}/${url}`
}
