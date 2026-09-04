/**
 * Response shapes of the /dsh-pluginhub/* host routes plus the pure helpers the
 * PluginHub UI shares between its section and toast components.
 */

export type { SharedHostPackageDependencyFinding } from '../diagnostics.ts'

/** The only two languages surfaced by DeepSeek Harness settings. */
export type PluginHubLanguage = 'zh' | 'en'

/** Localized pluginhub text. The public protocol only carries zh / en. */
export type LocalizedText = Partial<Record<PluginHubLanguage, string>>

/**
 * Follow the host setting exactly: Chinese variants use Chinese; every other
 * value uses English. Keeping this policy in one place prevents a future host
 * locale from accidentally falling through to the Chinese catalog copy.
 */
export function pluginHubLanguage(active: unknown): PluginHubLanguage {
  const locale = typeof active === 'string' ? active.trim().toLowerCase().replaceAll('_', '-') : ''
  return locale === 'zh' || locale.startsWith('zh-') ? 'zh' : 'en'
}

/** Resolve protocol text without ever falling back from English to Chinese. */
export function pluginHubText(value: LocalizedText | undefined, language: PluginHubLanguage): string {
  if (language === 'zh') return value?.zh || value?.en || ''
  return value?.en || ''
}

/** One registry entry from /dsh-pluginhub/registry. */
/**
 * Resolve a pluginhub API path against the page the UI is served from.
 *
 * Every call used to be root-absolute (`/dsh-pluginhub/…`), which the browser
 * resolves against the ORIGIN — so behind a reverse proxy that mounts dsh
 * under a prefix (`https://host/app/my-dsh/`), the panel rendered and then
 * every request in it went to `https://host/dsh-pluginhub/…`, missed the prefix
 * rule entirely, and 404'd (#345).
 *
 * Anchored on `document.baseURI`, which is the directory the host serves its
 * UI from. Safe for root deployments because that directory is `/` there, and
 * safe generally because the dsh web UI does not use path routing — measured
 * against a real dsh: `location.pathname` is `/` on the pluginhub page, not
 * `/settings/...`, so the directory really is the mount point rather than
 * wherever the user happens to have navigated.
 */
export function api(path: string): string {
  const relative = path.replace(/^\/+/, '')
  if (typeof document === 'undefined') return `/${relative}`
  return new URL(relative, document.baseURI).pathname
}

export interface RegistryPlugin {
  name: string
  owner: string
  url: string
  npm?: string | null
  tarball?: string | null
  /** One legacy category id or several category ids. */
  category: string | string[]
  description?: LocalizedText
  stars?: number
  /**
   * npm downloads in the last 30 days, when the entry has a published
   * package. Absent means "no npm package" — a coverage gap, not a zero.
   */
  downloads?: number | null
  added?: string
  install?: string
  /** Validation metadata supplied by dsh-plugin-hub's public API. */
  isVerified?: boolean
  installable?: boolean
  validationStatus?: 'pending' | 'verified' | 'build_required' | 'invalid'
  validationReason?: string
  requiresBuildAuthorization?: boolean
  updatedAt?: string
  /**
   * Catalog-side deprecation flags (#60): absent for every normal entry, so
   * catalogs without the fields render exactly as before.
   */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
  /** Author-curated screenshot URLs from the registry (#61); optional. */
  screenshots?: string[]
}

/** Category ids for one entry, de-duplicated in declaration order. */
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

/** The catalog payload under `registry` in /dsh-pluginhub/registry. */
export interface Registry {
  name?: string
  url?: string
  source?: string
  updated?: string
  count: number
  categories: Record<string, LocalizedText>
  sorts?: Record<string, LocalizedText>
  plugins: RegistryPlugin[]
  pagination?: {
    page: number
    pageSize: number
    total: number
    totalPages: number
    hasMore: boolean
    nextPage?: number
  }
}

/** Profile dependency map: package name → install spec. */
export type InstalledMap = Record<string, string>

/**
 * Add active profile Bundles as presence-only catalog entries.
 *
 * The returned map is for catalog matching only. Update and uninstall flows
 * must keep using the dependency-only map because a Bundle supplied by the
 * dsh installation is not owned by the profile package manager.
 */
export function installedForCatalog(installed: InstalledMap, bundles: readonly string[]): InstalledMap {
  return Object.fromEntries([
    ...bundles.map(name => [name, '*'] as const),
    ...Object.entries(installed),
  ])
}

/** Strong repo identities discovered for local link:/file: dependencies (#141). */
export type InstalledRepoIdentities = Record<string, string[]>

/** Weak Git-origin hints used only to disambiguate multiple same-named entries. */
export type InstalledRepoHints = Record<string, string[]>

/** Per-package update status from /dsh-pluginhub/updates. */
export interface UpdateStatus {
  updateAvailable?: boolean
  version?: string
  kind?: string
  /** What is installed and what the source of truth offers — versions for npm
      packages, commit shas for github installs; the notes dialog (#294) shows
      the range between them in whichever form reads best. */
  current?: string | null
  latest?: string | null
  /** Updating this local package switches it to its matched online release. */
  restoreRequired?: boolean
}

/** Poll payload from /dsh-pluginhub/status. */
export interface PluginHubStatus {
  /** The pluginhub's own version — rendered in the heading so screenshots carry it. */
  version?: string
  /** Whether the profile package manager owns the pluginhub dependency. */
  selfManaged?: boolean
  /**
   * Prefix to put in front of github.com URLs the BROWSER loads, or null to
   * address them directly. Resolved by the server from the download region.
   */
  githubProxy?: string | null
  active?: boolean
  lastLine?: string
  seconds?: number
  installed?: InstalledMap
  pnpm?: boolean
  boot?: string
  /** pnpm ndjson stage, when the structured reporter produced events. */
  phase?: 'resolving' | 'downloading' | 'linking' | 'building' | null
  done?: number
  total?: number | null
  currentPackage?: string | null
  downloaded?: number | null
  size?: number | null
  /** True once the user asked to cancel and the host is killing the run. */
  cancelling?: boolean
  /**
   * The route-level operation lock (#91): stays true through install
   * post-processing after pnpm already exited (progress.active false).
   * Restart must not be offered while it is held.
   */
  busy?: boolean
  /**
   * The process supervisor the host detected around itself (systemd, pm2),
   * or null/absent when none. Present so the UI can explain WHY the restart
   * button is missing instead of just omitting it (#229).
   */
  supervisor?: string | null
  /**
   * Debugger latch (#447): `'inspector'` when the host is under a debugger,
   * or null/absent otherwise. Kept separate from `supervisor` and from
   * `restart` so `allowRestart` settings are not conflated with debug state.
   */
  debugger?: string | null
}

/** Post-install activation state (P0-2), per installed package. */
export type ActivationState = 'live' | 'restart' | 'inert' | 'broken' | 'missing' | 'disabled'

export interface ActivationInfo {
  state: ActivationState
  reasons: string[]
  bundle: boolean
  hot: boolean
}

/** Bound locale translator for the dsh-pluginhub namespace. */
export type Translate = (key: string) => string

export function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return 'hsl(' + (((hash % 360) + 360) % 360) + ' 55% 52%)'
}

export function readSession(key: string): any {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') } catch { return null }
}

/** Heuristic: plugins that target a terminal surface rather than the web UI. */
export function looksTerminal(plugin: RegistryPlugin, lang: PluginHubLanguage): boolean {
  const desc = pluginHubText(plugin.description, lang)
  // A description can mention a CLI only to say it is NOT required. Treating
  // that as positive evidence labels web plugins as terminal-only. Strip
  // bounded negated clauses before applying the deliberately broad heuristic;
  // the package name remains untouched and therefore stays strong evidence.
  const positiveDesc = desc
    .replace(/\b(?:no|without)\b[^.!?;:，。！？；\n]{0,80}\b(?:tui|cli|tty|terminal)\b/gi, '')
    .replace(/(?:无需|无须|不需要|不用)[^。！？；\n]{0,48}(?:tui|cli|tty|terminal|终端|命令行)/gi, '')
  return /\b(tui|cli|tty|terminal)\b|终端|命令行/i.test(plugin.name + ' ' + positiveDesc)
}

/**
 * Unified installed-state matching (#15): both sides collapse to lowercase
 * identity sets — the registry entry contributes its bare name, npm name and
 * owner/repo; the dependency contributes its key and the repo inside its
 * spec — and any exact intersection counts. Exact equality, not substrings,
 * so prefix-related repo names cannot cross-match.
 */
/**
 * Memo for entryIdentities, keyed on the catalog entry object itself.
 *
 * Catalog entries are parsed once and never mutated, so the identity set is
 * a pure function of an object that outlives every call — a WeakMap holds
 * it for exactly as long as the catalog is alive and not one render longer.
 * Worth caching because this is the innermost step of the installed-state
 * matching that runs for every card on screen (#262).
 */
const entryIdCache = new WeakMap<RegistryPlugin, Set<string>>()

function entryIdentities(plugin: RegistryPlugin): Set<string> {
  const cached = entryIdCache.get(plugin)
  if (cached !== undefined) return cached
  const ids = new Set<string>([plugin.name.toLowerCase()])
  if (plugin.npm) ids.add(plugin.npm.toLowerCase())
  // Subpath-aware: a /tree/ entry identifies as repo#path:/sub, never the
  // bare repo — two subpackages of one monorepo must not cross-match.
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url)
  if (m !== null) {
    ids.add(m[2] !== undefined ? `${m[1]!.toLowerCase()}#path:/${m[2].toLowerCase()}` : m[1]!.toLowerCase())
  }
  entryIdCache.set(plugin, ids)
  return ids
}

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#path:\/[A-Za-z0-9_./-]+)?$/

function addRepoIdentities(ids: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    if (!REPO_ID_RE.test(value)) continue
    const subpath = value.split('#path:/')[1]
    if (subpath !== undefined && subpath.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) continue
    ids.add(value.toLowerCase())
  }
}

/** Repo identities carried by a github shortcut, including `#sha&path:`. */
function githubSpecRepoIds(spec: string): Set<string> {
  const ids = new Set<string>()
  const match = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/i.exec(spec)
  if (match === null) return ids
  const repo = match[1]!.toLowerCase()
  let subpath: string | null = null
  for (const selector of (match[2] ?? '').split('&')) {
    if (!selector.startsWith('path:/')) continue
    const candidate = selector.slice('path:/'.length)
    if (!REPO_ID_RE.test(`${repo}#path:/${candidate}`)
      || candidate.split('/').some(seg => seg === '' || seg === '.' || seg === '..')
      || subpath !== null) return new Set()
    subpath = candidate.toLowerCase()
  }
  ids.add(repo)
  if (subpath !== null) ids.add(`${repo}#path:/${subpath}`)
  return ids
}

function depIdentities(name: string, spec: string, repoIdentities: readonly string[] = []): Set<string> {
  const ids = new Set<string>([name.toLowerCase()])
  // A scoped npm key usually mirrors owner/repo — expose that identity so an
  // npm-installed plugin still matches an entry whose npm field is unset.
  const scoped = /^@([^/]+)\/(.+)$/.exec(name)
  if (scoped !== null) ids.add(`${scoped[1]!.toLowerCase()}/${scoped[2]!.toLowerCase()}`)
  for (const id of githubSpecRepoIds(spec)) ids.add(id)
  addRepoIdentities(ids, repoIdentities)
  return ids
}

/**
 * Repo identities stated by the dependency SPEC itself (github: installs) —
 * hard evidence of where the package came from, unlike the name-derived
 * mirror in depIdentities, which is only a matching aid.
 */
function depRepoIds(spec: string, repoIdentities: readonly string[] = []): Set<string> {
  const ids = githubSpecRepoIds(spec)
  addRepoIdentities(ids, repoIdentities)
  return ids
}

/** Repo identity of a registry entry's source url (repo or repo#path form). */
function entryRepoIds(plugin: RegistryPlugin): Set<string> {
  const ids = new Set<string>()
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url)
  if (m !== null) {
    ids.add(m[2] !== undefined ? `${m[1]!.toLowerCase()}#path:/${m[2].toLowerCase()}` : m[1]!.toLowerCase())
  }
  return ids
}

/**
 * The curated registry lists distinct plugins sharing one name — twelve
 * name-groups at the time of #66 (both dsh-usage-stats, four dsh-memory…).
 * A name coincidence must not survive contradicting repo evidence: when the
 * dependency's spec pins a github repo AND the entry states one, the repos
 * decide — the loose name/npm identities only apply when at least one side
 * carries no repo evidence (npm installs, non-github entries).
 */
function sameSourceConflict(plugin: RegistryPlugin, spec: string, repoIdentities: readonly string[] = []): boolean {
  const entry = entryRepoIds(plugin)
  const dep = depRepoIds(spec, repoIdentities)
  if (entry.size === 0 || dep.size === 0) return false
  for (const id of dep) if (entry.has(id)) return false
  return true
}

function repoHintMatches(plugin: RegistryPlugin, hints: readonly string[]): boolean {
  const entry = entryRepoIds(plugin)
  const values = new Set<string>()
  addRepoIdentities(values, hints)
  for (const id of values) if (entry.has(id)) return true
  return false
}

/**
 * Memo for looseMatchCount, keyed on the catalog array then the dep name.
 *
 * This is THE hot path behind "the plugin list is very laggy" (#262). The
 * count answers "how many catalog entries could this installed dependency
 * be?", which depends only on the catalog and the name — not on the card
 * being drawn. But it was called from matchInstalledName, which runs once
 * per installed dependency, which runs once per rendered card: a full scan
 * of ~1800 entries, repeated cards × installed times, on every single
 * render. A profile from the reporter put it at 2.9 seconds, 28% of the
 * whole trace, and a local benchmark measured 48ms per render at 24 cards
 * and 224ms at 96 against a smaller 839-entry catalog.
 *
 * Keyed on the array identity so a refetched catalog gets a fresh map for
 * free — a new parse is a new array, and the old one is collectable.
 */
const looseMatchCountCache = new WeakMap<RegistryPlugin[], Map<string, number>>()

function looseMatchCount(plugins: RegistryPlugin[], name: string): number {
  let byName = looseMatchCountCache.get(plugins)
  if (byName === undefined) {
    byName = new Map<string, number>()
    looseMatchCountCache.set(plugins, byName)
  }
  const hit = byName.get(name)
  if (hit !== undefined) return hit
  // Built once for the whole scan. looseMatches() rebuilt this identity set
  // for every entry it tested, so the allocation alone ran ~1800 times per
  // call before this.
  const dep = depIdentities(name, '')
  let count = 0
  for (const plugin of plugins) {
    for (const id of entryIdentities(plugin)) {
      if (dep.has(id)) { count += 1; break }
    }
  }
  byName.set(name, count)
  return count
}

function looseMatches(plugin: RegistryPlugin, name: string): boolean {
  const dep = depIdentities(name, '')
  for (const id of entryIdentities(plugin)) if (dep.has(id)) return true
  return false
}

/** The installed dependency name a registry entry corresponds to, or null. */
export function matchInstalledName(
  plugin: RegistryPlugin,
  installed: InstalledMap,
  repoIdentities: InstalledRepoIdentities = {},
  plugins?: RegistryPlugin[],
  repoHints: InstalledRepoHints = {},
): string | null {
  const ids = entryIdentities(plugin)
  for (const [name, spec] of Object.entries(installed)) {
    const repos = repoIdentities[name] ?? []
    if (depRepoIds(String(spec), repos).size === 0 && plugins !== undefined && looseMatchCount(plugins, name) > 1
      && !repoHintMatches(plugin, repoHints[name] ?? [])) continue
    if (sameSourceConflict(plugin, String(spec), repos)) continue
    for (const id of depIdentities(name, String(spec), repos)) {
      if (ids.has(id)) return name
    }
  }
  return null
}

/** The registry entry an installed dependency corresponds to, or undefined. */
export function entryForDep(
  plugins: RegistryPlugin[],
  name: string,
  spec: string,
  repoIdentities: readonly string[] = [],
  repoHints: readonly string[] = [],
): RegistryPlugin | undefined {
  if (depRepoIds(String(spec), repoIdentities).size === 0 && looseMatchCount(plugins, name) > 1) {
    const hinted = plugins.find(plugin => repoHintMatches(plugin, repoHints) && looseMatches(plugin, name))
    if (hinted === undefined) return undefined
  }
  const ids = depIdentities(name, String(spec), repoIdentities)
  return plugins.find((plugin) => {
    if (sameSourceConflict(plugin, String(spec), repoIdentities)) return false
    for (const id of entryIdentities(plugin)) if (ids.has(id)) return true
    return false
  })
}

export function isInstalled(
  plugin: RegistryPlugin,
  installed: InstalledMap,
  repoIdentities: InstalledRepoIdentities = {},
  plugins?: RegistryPlugin[],
  repoHints: InstalledRepoHints = {},
): boolean {
  return matchInstalledName(plugin, installed, repoIdentities, plugins, repoHints) !== null
}

// ------------------------------------------------------------- screenshots

/**
 * Prefix for github.com URLs this page loads, or null to address them
 * directly. Set from the status poll, which gets it from the download region.
 *
 * Module state rather than a prop: the URLs it applies to are built in four
 * places across two files (avatars, README fetches, screenshot thumbnails),
 * and threading one string through every card would put it in signatures
 * that have no other reason to know about networking.
 *
 * Applied at the LAST moment, never stored. Extracted image URLs stay
 * canonical, so changing region re-renders against the new route instead of
 * leaving a page full of links to a proxy the user just switched away from.
 */
let githubProxy: string | null = null

/** Point browser-side github.com requests at a proxy, or null for direct. */
export function setGithubProxy(proxy: string | null): void {
  githubProxy = proxy
}

/** The proxy in force, for callers that must decide between two URL shapes. */
export function githubProxyInUse(): string | null {
  return githubProxy
}

/** `url` through the proxy in force, or unchanged when there is none. */
export function githubUrl(url: string): string {
  return githubProxy === null ? url : `${githubProxy}/${url}`
}

/**
 * Image hosts screenshots may load from (#61) — GitHub's own hosting only.
 * Any other host is dropped BEFORE an <img> is created: a screenshot URL is
 * a request carrying the user's IP, so registry data and README content are
 * both treated as untrusted here, matching the upstream build gate.
 */
const SCREENSHOT_HOSTS = new Set([
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.com',
])

const MAX_SCREENSHOTS = 6

/** A README image together with the evidence used to rank it as a preview. */
export interface ScreenshotCandidate {
  src: string
  semanticScore: number
  order: number
  curated: boolean
}

/** Return one safe screenshot URL without applying the public list limit. */
function safeScreenshot(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let parsed: URL
  try { parsed = new URL(value) } catch { return null }
  if (parsed.protocol !== 'https:' || !SCREENSHOT_HOSTS.has(parsed.hostname)) return null
  if (/\.svg$/iu.test(parsed.pathname)) return null
  return value
}

/** Keep only https URLs on allowlisted image hosts; SVG dropped (logos/badges). */
export function safeScreenshots(urls: unknown): string[] {
  if (!Array.isArray(urls)) return []
  const safe: string[] = []
  for (const value of urls) {
    const src = safeScreenshot(value)
    if (src === null) continue
    if (!safe.includes(src)) safe.push(src)
    if (safe.length >= MAX_SCREENSHOTS) break
  }
  return safe
}

const PREVIEW_WORDS = /(?:preview|screen[ -]?shots?|shots?|demo|showcase|gallery|theme|skin|appearance|效果|预览|截图|演示|展示|界面|主题|皮肤)/iu
const FULL_PREVIEW_WORDS = /(?:full|overview|home|main|conversation|chat|workspace|dashboard|完整|主页|首页|全景|主界面)/iu
const PARTIAL_PREVIEW_WORDS = /(?:settings?|panel|dialog|modal|picker|menu|controls?|fragment|crop|detail|配置|设置|面板|弹窗|局部|细节)/iu
const NON_PREVIEW_WORDS = /(?:badge|shield|logo|icon|avatar|sponsor|donat|fund|qr(?:code)?|wechat|qq(?:group)?|npm|build|coverage|license|status|button|favicon|徽章|图标|头像|赞助|捐赠|二维码|微信|交流群)/iu

interface ReadmeImageParts {
  src: string
  alt: string
  title: string
  width: number | null
  height: number | null
}

/** A quoted or unquoted HTML attribute; README HTML is data, never rendered. */
function htmlAttribute(html: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(html)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
}

function numericDimension(raw: string): number | null {
  if (!/^\d+(?:\.\d+)?$/u.test(raw.trim())) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolve one README image path to the canonical GitHub-hosted URL. */
function resolveReadmeImage(raw: string, owner: string, repo: string, base: string): string | null {
  const src = raw.trim().replace(/^<|>$/g, '')
  if (src === '' || src.startsWith('data:')) return null
  let absolute: string
  if (/^https?:\/\//iu.test(src)) {
    absolute = src
  } else if (src.startsWith('/')) {
    absolute = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD${src}`
  } else {
    try { absolute = new URL(src, base).href } catch { return null }
  }
  return safeScreenshot(absolute)
}

/** Score evidence available without downloading the image itself. */
function readmeSemanticScore(
  image: ReadmeImageParts,
  heading: string,
  nearby: string,
  order: number,
  offset: number,
): number {
  const label = `${image.alt} ${image.title}`
  const path = (() => {
    try {
      const parsed = new URL(image.src)
      // Do not count owner/repository names as image evidence: practically
      // every entry here contains "theme" or "skin" in its repo name.
      if (parsed.hostname === 'raw.githubusercontent.com') {
        return '/' + parsed.pathname.split('/').slice(4).join('/')
      }
      return parsed.pathname
    } catch { return image.src }
  })()
  let score = 20 + Math.max(0, 8 - order)
  if (PREVIEW_WORDS.test(label)) score += 55
  if (PREVIEW_WORDS.test(path)) score += 40
  if (PREVIEW_WORDS.test(heading)) score += 32
  if (PREVIEW_WORDS.test(nearby)) score += 12
  if (FULL_PREVIEW_WORDS.test(`${label} ${path}`)) score += 35
  if (PARTIAL_PREVIEW_WORDS.test(`${label} ${path}`)) score -= 30
  if (NON_PREVIEW_WORDS.test(label)) score -= 140
  if (NON_PREVIEW_WORDS.test(path)) score -= 120
  if (NON_PREVIEW_WORDS.test(heading)) score -= 55
  if (NON_PREVIEW_WORDS.test(nearby)) score -= 18
  // A title-block image with no screenshot evidence is usually branding.
  if (offset < 500 && !PREVIEW_WORDS.test(`${label} ${path} ${heading}`)) score -= 20
  if (image.width !== null && image.height !== null) {
    score += previewDimensionScore(image.width, image.height) ?? -500
  } else if ((image.width ?? image.height ?? Number.POSITIVE_INFINITY) < 240) {
    score -= 100
  }
  return score
}

/**
 * Ranked README image candidates for use when the catalog has no curated
 * screenshots. Ranking uses the image label/path, nearest heading, nearby
 * prose, declared dimensions and document position. This prevents a title
 * logo or a row of tiny badges from consuming the six-candidate limit before
 * a later Screenshots section is reached.
 */
export function extractReadmeImageCandidates(
  markdown: string,
  owner: string,
  repo: string,
  subpath: string | null,
): ScreenshotCandidate[] {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${subpath === null ? '' : subpath + '/'}`
  const headings = [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)]
    .map(match => ({ offset: match.index, text: match[1] ?? '' }))
  const found = new Map<string, ScreenshotCandidate>()
  let headingIndex = -1
  let order = 0
  // Markdown and HTML image forms stay in one pass, preserving position.
  const imagePattern = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*\)|<img\b([^>]*?)\/?\s*>/gimu
  for (const match of markdown.matchAll(imagePattern)) {
    while (headingIndex + 1 < headings.length && headings[headingIndex + 1]!.offset < match.index) headingIndex += 1
    const html = match[7] ?? ''
    const rawSrc = match[2] ?? match[3] ?? htmlAttribute(html, 'src')
    const src = resolveReadmeImage(rawSrc, owner, repo, base)
    if (src === null) continue
    const image: ReadmeImageParts = {
      src,
      alt: match[1] ?? htmlAttribute(html, 'alt'),
      title: match[4] ?? match[5] ?? match[6] ?? htmlAttribute(html, 'title'),
      width: numericDimension(htmlAttribute(html, 'width')),
      height: numericDimension(htmlAttribute(html, 'height')),
    }
    const heading = headings[headingIndex]?.text ?? ''
    const nearby = markdown.slice(Math.max(0, match.index - 100), Math.min(markdown.length, match.index + match[0].length + 100))
    const candidate: ScreenshotCandidate = {
      src,
      semanticScore: readmeSemanticScore(image, heading, nearby, order, match.index),
      order,
      curated: false,
    }
    const previous = found.get(src)
    if (previous === undefined || candidate.semanticScore > previous.semanticScore) found.set(src, candidate)
    order += 1
  }
  return [...found.values()]
    .filter(candidate => candidate.semanticScore >= 20)
    .sort((a, b) => b.semanticScore - a.semanticScore || a.order - b.order)
    .slice(0, MAX_SCREENSHOTS)
}

/** Ranked README image URLs; retained as the simple public extraction API. */
export function extractReadmeImages(markdown: string, owner: string, repo: string, subpath: string | null): string[] {
  return extractReadmeImageCandidates(markdown, owner, repo, subpath).map(candidate => candidate.src)
}

/**
 * Score dimensions from a 240px-high, no-upscale probe.
 *
 * A product preview should resemble a complete desktop surface: landscape,
 * neither a narrow crop nor a panoramic strip, and large enough to inspect.
 * Small square logos and portrait fragments intentionally return null.
 */
export function previewDimensionScore(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const ratio = width / height
  const area = width * height
  if (width < 280 || height < 150 || area < 48_000 || ratio < 1.05 || ratio > 3.2) return null
  let score = Math.min(28, Math.round(area / 4_000))
  if (ratio >= 1.35 && ratio <= 2.05) score += 48
  else if (ratio >= 1.18 && ratio <= 2.4) score += 28
  else score += 8
  if (width >= 320 && height >= 180) score += 14
  return score
}

const readmeShotsCache = new Map<string, Promise<ScreenshotCandidate[]>>()

/** Test hook: the cache is module-level and outlives component unmounts. */
export function resetScreenshotsCache(): void {
  readmeShotsCache.clear()
}

/**
 * Screenshot candidates for a plugin: the registry's curated list when
 * present, otherwise lazily extracted and semantically ranked from README.
 */
export function pluginScreenshotCandidates(plugin: RegistryPlugin): Promise<ScreenshotCandidate[]> {
  const curated = safeScreenshots(plugin.screenshots)
  if (curated.length > 0) {
    return Promise.resolve(curated.map((src, order) => ({ src, order, semanticScore: 1_000 - order, curated: true })))
  }
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url)
  if (m === null) return Promise.resolve([])
  const [, owner, repo, subpath = null] = m
  const cacheKey = plugin.url
  const cached = readmeShotsCache.get(cacheKey)
  if (cached !== undefined) return cached
  const fetchReadme = async (path: string | null): Promise<string | null> => {
    try {
      const res = await fetch(githubUrl(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path === null ? '' : path + '/'}README.md`))
      return res.ok ? await res.text() : null
    } catch {
      return null
    }
  }
  const task = (async () => {
    // Monorepo subpath entries prefer their own README, falling back to the
    // repo root; shots in the subpath README resolve against its directory.
    const sub = subpath === null ? null : await fetchReadme(subpath)
    if (sub !== null) return extractReadmeImageCandidates(sub, owner!, repo!, subpath)
    const root = await fetchReadme(null)
    return root === null ? [] : extractReadmeImageCandidates(root, owner!, repo!, null)
  })().catch(() => [] as ScreenshotCandidate[])
  readmeShotsCache.set(cacheKey, task)
  return task
}

/** Screenshot URLs for plugin dialogs. */
export async function pluginScreenshots(plugin: RegistryPlugin): Promise<string[]> {
  return (await pluginScreenshotCandidates(plugin)).map(candidate => candidate.src)
}

/**
 * The human-readable part of a failed command's output.
 *
 * pnpm's ndjson reporter writes one JSON object per progress tick, and a
 * large `github:` download emits thousands of them. When a failure matches
 * none of the known signatures there is no diagnosis to show, so the UI
 * falls back to the tail of stdout/stderr — which for exactly that case is
 * 600 characters of `{"name":"pnpm:fetching-progress","downloaded":…}`.
 * The user is handed machine noise at the one moment they need a sentence
 * (#148, and the same shape behind #161).
 *
 * Progress objects are dropped; anything else — including JSON carrying a
 * real message — is kept, because an unrecognized failure is precisely when
 * throwing information away is most expensive.
 */
export function humanOutput(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('{')) { kept.push(line); continue }
    try {
      const parsed = JSON.parse(trimmed) as { name?: unknown; err?: unknown; message?: unknown }
      const name = typeof parsed.name === 'string' ? parsed.name : ''
      // Keep anything that carries a diagnosis, drop pure progress chatter.
      if (parsed.err !== undefined || typeof parsed.message === 'string') { kept.push(line); continue }
      if (name.startsWith('pnpm:')) continue
      kept.push(line)
    } catch {
      kept.push(line)
    }
  }
  return kept.join('\n').trim()
}

/**
 * The plugin's own name, for display.
 *
 * The catalog's `name` is an IDENTITY, and for the 104 entries that live in
 * a repository holding several plugins it is a compound one:
 * `dsh-web#packages/dsh-web-all`. Shown verbatim it puts a repository
 * path in front of a user who did not ask about repositories — and worse, it
 * disagrees with the pluginhub's own installed list, which reads names out of
 * the profile manifest and calls the same plugin `dsh-web-all`. The same
 * thing had two names either side of the Install button.
 *
 * A card answers two questions: who made it, and what is it called. The
 * author is drawn beside their avatar as one unit, so the title is free to
 * be just the plugin. Duplicate titles across authors are fine — the byline
 * is what separates them — which is why this does not try to keep the
 * repository as a qualifier.
 *
 * The repository name IS the plugin name in the ordinary case, because a
 * repository holding one plugin is named after it. Only the compound form
 * needs unpicking, and its last segment is the plugin's own directory.
 *
 * Not a substitute for the identity: every key, lookup and install still
 * uses `name` unchanged.
 */
export function pluginName(name: string): string {
  const hash = name.indexOf('#')
  if (hash === -1) return name
  const sub = name.slice(hash + 1)
  const leaf = sub.slice(sub.lastIndexOf('/') + 1)
  // A sub-path that is empty or trailing-slashed tells us nothing; the
  // repository half is a better answer than an empty title.
  return leaf === '' ? name.slice(0, hash) : leaf
}

/**
 * Compact display for a count that can run into the tens of thousands
 * (npm downloads, star counts): "11.9k" instead of "11862". Reported —
 * the raw number made the card byline visibly cramped once downloads was
 * added alongside stars.
 *
 * Below 1000 the exact number is shown; a small count is exactly the case
 * where the precision matters and abbreviating it buys nothing.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(n)
  const k = Math.round(n / 100) / 10
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
}
