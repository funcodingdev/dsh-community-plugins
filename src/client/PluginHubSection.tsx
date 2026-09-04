/**
 * The PluginHub settings section: Discover / Installed tabs over the
 * /dsh-pluginhub/* host routes, with install/update/uninstall flows and the
 * pending-restart bookkeeping in sessionStorage.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Star } from 'lucide-react'
import { PLUGINHUB_PACKAGE_NAME } from '../package-name.ts'
import {
  Button,
  DisclosureRow,
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconCheckOutline16,
  IconCloseOutline16,
  IconCodeOutline16,
  IconCordisPluginOutline14,
  IconDownloadOutline16,
  IconLoadingOutline16,
  IconQuestionOutline14,
  IconRefreshOutline14,
  IconRightUpOutline14,
  IconSearchOutline16,
  IconSparkle16,
  IconWarningOutline16,
  Input,
  Menu,
  Modal,
  StateDot,
  Toast,
  Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PluginHub.module.css'
import { CommentsModal } from './CommentsModal.tsx'
import { CategoryList } from './CategoryList.tsx'
import { COMMENTS_ENABLED } from './comments.ts'
import { OperationsPanel } from './OperationsPanel.tsx'
import { clearSettled, drop, enqueue, patch as patchRecord, recordForUrl } from './operations.ts'
import type { OperationRecord } from './operations.ts'
import {
  api, avatarColor, entryForDep, githubProxyInUse, githubUrl, humanOutput, installedForCatalog, isInstalled, looksTerminal, pluginCategories,
  formatCount, pluginHubLanguage, pluginHubText, pluginName, pluginScreenshots, readSession, setGithubProxy,
} from './pluginhub-data.ts'
import type {
ActivationInfo, ActivationState, InstalledMap, InstalledRepoHints, InstalledRepoIdentities, PluginHubStatus, Registry, RegistryPlugin,
  PluginHubLanguage, SharedHostPackageDependencyFinding, Translate, UpdateStatus,
} from './pluginhub-data.ts'

function isHostDependencyFinding(value: unknown): value is SharedHostPackageDependencyFinding {
  if (value === null || typeof value !== 'object') return false
  const finding = value as Partial<SharedHostPackageDependencyFinding>
  return finding.code === 'shared-host-package-dependency'
    && finding.severity === 'warning'
    && finding.subject?.kind === 'package'
    && typeof finding.subject.name === 'string'
    && finding.evidence?.basis === 'manifest-declaration'
    && typeof finding.evidence?.dependency === 'string'
    && typeof finding.evidence.declaredRange === 'string'
    && finding.evidence.declaredIn === 'dependencies'
}

const HOST_DEPENDENCY_PREVIEW_LIMIT = 5
const IGNORED_UPDATES_SESSION_KEY = 'dsph-updates-ignored'

/**
 * Read the update reminders dismissed for this host process. The boot id is
 * part of the value rather than the key so sessionStorage never accumulates
 * one orphaned entry per process. Invalid and stale records fail open: an
 * update reminder is safer than silently hiding one we cannot account for.
 */
function ignoredUpdatesForBoot(boot: string): string[] {
  const saved = readSession(IGNORED_UPDATES_SESSION_KEY)
  const valid = saved !== null
    && typeof saved === 'object'
    && !Array.isArray(saved)
    && saved.boot === boot
    && Array.isArray(saved.names)
    && saved.names.every((name: unknown) => typeof name === 'string' && name !== '')
  if (!valid) {
    try { sessionStorage.removeItem(IGNORED_UPDATES_SESSION_KEY) } catch { /* storage unavailable */ }
    return []
  }
  return [...new Set(saved.names as string[])]
}

function HostDependencyDiagnostics({
  findings,
  t,
}: {
  findings: SharedHostPackageDependencyFinding[]
  t: Translate
}) {
  if (findings.length === 0) return null
  const preview = findings.slice(0, HOST_DEPENDENCY_PREVIEW_LIMIT)
  const remaining = findings.length - preview.length
  return (
    <div className={css.banner}>
      <IconWarningOutline16 size={14} className={css.bannerIcon} />
      <span className={css.grow}>
        <div>{t('hostDependencyWarning')}</div>
        {preview.map(finding => (
          <div
            key={`${finding.subject.name}:${finding.evidence.dependency}`}
            className={css.spec}
          >
            {finding.subject.name} → {finding.evidence.dependency}@{finding.evidence.declaredRange}
          </div>
        ))}
        {remaining > 0 && (
          <div className={css.spec}>{t('hostDependencyMore').replace('{0}', String(remaining))}</div>
        )}
      </span>
    </div>
  )
}

/** The state label + dot for one activation result (P0-2). */
function activationMeta(state: ActivationState, t: Translate): { label: string; dot: 'done' | 'warning' | 'error' } {
  if (state === 'live') return { label: t('stateLive'), dot: 'done' }
  if (state === 'restart') return { label: t('stateRestart'), dot: 'warning' }
  if (state === 'inert') return { label: t('stateInert'), dot: 'warning' }
  if (state === 'broken') return { label: t('stateBroken'), dot: 'error' }
  if (state === 'disabled') return { label: t('stateDisabled'), dot: 'warning' }
  return { label: '—', dot: 'warning' }
}

function phaseLabel(phase: NonNullable<PluginHubStatus['phase']>, t: Translate): string {
  if (phase === 'resolving') return t('phaseResolving')
  if (phase === 'downloading') return t('phaseDownloading')
  if (phase === 'linking') return t('phaseLinking')
  return t('phaseBuilding')
}

type DiscoverSort = 'recommended' | 'updated' | 'stars'

const DISCOVER_SORT_OPTIONS: ReadonlyArray<{ key: DiscoverSort; label: string }> = [
  { key: 'recommended', label: 'sortRecommended' },
  { key: 'updated', label: 'sortRecentlyUpdated' },
  { key: 'stars', label: 'sortMostStars' },
]

/** The public directory's three canonical sort modes, rendered with the
 * official Menu/Button primitives. */
function FilterMenu({ value, onChange, sorts, lang, t }: {
  value: DiscoverSort
  onChange: (value: DiscoverSort) => void
  sorts: Registry['sorts']
  lang: PluginHubLanguage
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  const items = useMemo<MenuEntry[]>(
    () => DISCOVER_SORT_OPTIONS.map(option => ({
      id: option.key,
      label: pluginHubText(sorts?.[option.key], lang) || t(option.label),
    })),
    [sorts, lang, t],
  )
  const selectedIds = useMemo(() => [value], [value])
  const activeFallback = DISCOVER_SORT_OPTIONS.find(option => option.key === value)?.label ?? 'sortRecommended'
  const activeLabel = pluginHubText(sorts?.[value], lang) || t(activeFallback)
  const onSelect = (id: string) => {
    if (DISCOVER_SORT_OPTIONS.some(option => option.key === id)) onChange(id as DiscoverSort)
    setOpen(false)
  }
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      onSelect={onSelect}
      selectedIds={selectedIds}
      align="end"
      portal
      anchor={(
        <Button
          variant="outline"
          size="sm"
          icon={open ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
          aria-label={`${t('filter')}: ${activeLabel}`}
          onClick={() => setOpen(o => !o)}
        >{activeLabel}</Button>
      )}
      items={items}
    />
  )
}

/**
 * Card avatar: the plugin owner's GitHub avatar (no API, browser-cached),
 * falling back to the initial-letter tile when it can't load.
 */
/** Inline pass: `code` spans and **bold**, everything else plain text. */
function mdInline(text: string): Array<string | JSX.Element> {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i} className={css.notesCode}>{part.slice(1, -1)}</code>
    }
    return part
  })
}

/**
 * Release-body markdown, reduced to what a reading dialog needs: headings,
 * bullets, paragraphs, bold, inline code. Every character arrives as a React
 * text child (auto-escaped) — nothing from the repo is ever interpreted as
 * markup, so this stays free of the HTML surface real markdown parsers open.
 */
function renderMarkdown(md: string): Array<JSX.Element | string> {
  const out: Array<JSX.Element | string> = []
  let bullets: string[] | null = null
  const flushList = (): void => {
    if (bullets === null) return
    const items = bullets
    out.push(<ul key={`l${out.length}`} className={css.notesList}>{items.map((item, i) => <li key={i}>{mdInline(item)}</li>)}</ul>)
    bullets = null
  }
  for (const line of md.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') { flushList(); continue }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flushList()
      out.push(<div key={`h${out.length}`} className={css.notesH}>{mdInline(heading[1])}</div>)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet !== null) {
      ;(bullets ??= []).push(bullet[1])
      continue
    }
    flushList()
    out.push(<div key={`p${out.length}`} className={css.notesP}>{mdInline(line)}</div>)
  }
  flushList()
  return out
}

function OwnerAvatar({ name, owner }: { name: string; owner: string }) {
  const [failed, setFailed] = useState(false)
  if (failed || owner === '') {
    return (
      <div className={css.av} style={{ background: avatarColor(name) }}>
        {name.replace(/^dsh[-_]/i, '').charAt(0).toUpperCase() || 'P'}
      </div>
    )
  }
  return (
    <img
      className={css.av}
      src={avatarUrl(owner)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * AppStore-style screenshot strip in the install detail dialog (#61).
 * Curated registry screenshots win; otherwise images are extracted from the
 * repo README. Requests start only once the dialog opens; failures — no
 * README, no images, broken links — degrade to rendering nothing at all.
 */
function ScreenshotStrip({ plugin, onOpen }: { plugin: RegistryPlugin; onOpen: (shots: string[], index: number) => void }) {
  const [shots, setShots] = useState<string[]>([])
  const [broken, setBroken] = useState<string[]>([])
  useEffect(() => {
    let live = true
    setShots([])
    setBroken([])
    pluginScreenshots(plugin).then((list) => { if (live) setShots(list) })
    return () => { live = false }
  }, [plugin])
  const visible = shots.filter(src => !broken.includes(src))
  if (visible.length === 0) return null
  return (
    <div className={css.shots}>
      {visible.map((src, i) => (
        <img
          key={src}
          className={css.shot}
          src={thumbUrl(src, 300)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onClick={() => onOpen(visible, i)}
          onError={() => setBroken(prev => prev.includes(src) ? prev : prev.concat(src))}
        />
      ))}
    </div>
  )
}

/**
 * Advances an index every `intervalMs` while `count > 1` — the shared clock
 * behind both a card's auto-cycling thumbnail and the lightbox. A manual
 * jump (clicking a dot, an arrow, opening on a specific shot) restarts the
 * clock instead of letting it fire again moments later: without that, a
 * deliberate "go back one" reads as broken when it auto-advances right past
 * where the user just navigated to.
 *
 * `intervalMs <= 0` disables the timer entirely (no auto-advance at all);
 * manual jumps still work. The lightbox uses this: a full-bleed image needs
 * to stay put until the viewer moves on, so it must never page itself.
 */
function useAutoCarousel(count: number, initial: number, intervalMs = 3500): [number, (i: number) => void] {
  const [index, setIndexState] = useState(initial)
  const [resetTick, setResetTick] = useState(0)
  useEffect(() => {
    if (count <= 1 || intervalMs <= 0) return
    const timer = setInterval(() => { setIndexState(i => (i + 1) % count) }, intervalMs)
    return () => clearInterval(timer)
  }, [count, intervalMs, resetTick])
  const setIndex = (i: number): void => {
    if (count <= 0) return
    setIndexState(((i % count) + count) % count)
    setResetTick(t => t + 1)
  }
  return [index, setIndex]
}

/**
 * A card thumbnail (or dialog strip image) renders at well under 150px on
 * screen; the curated screenshot behind it can be a full-resolution PNG
 * several hundred KB to a few MB — GitHub's own hosts offer no resized
 * variant, so rendering the original meant downloading full-size images for
 * a strip nobody asked to see full-size. images.weserv.nl resizes
 * server-side (by decoded HEIGHT, `fit=inside` so it never crops, `we=1` so
 * it never upscales something already smaller) before the bytes reach the
 * browser. The lightbox — an explicit "show me this big" — still requests
 * the ORIGINAL directly: proxying that one too would add a hop with nothing
 * left to save, and once the thumbnail is genuinely smaller it can no longer
 * share a cache entry with the full-size open anyway.
 */
function thumbUrl(src: string, height: number): string {
  // The resizer stays in every region, including China.
  //
  // It was briefly bypassed there on the assumption that a service in the
  // Netherlands would be one more far-away host in the way. Measured from an
  // unproxied mainland connection, that was wrong twice over: weserv answers
  // in 1.39s, and it answers with 23KB where the original is 41KB. Routing
  // around it would have traded a working request for a bigger one, on a
  // page that makes dozens of them.
  return `https://images.weserv.nl/?url=${encodeURIComponent(src.replace(/^https?:\/\//, ''))}&h=${String(height)}&fit=inside&we=1`
}

/**
 * The owner's GitHub avatar, addressed so the region's proxy can serve it.
 *
 * `github.com/<owner>.png` is a redirect to the avatar host, and gh-proxy
 * does not follow it — measured from an unproxied mainland connection, that
 * URL hangs until the client gives up (60s), while naming the avatar host
 * directly through the same proxy answers in 1.07s. So a proxied region
 * addresses the destination itself.
 *
 * The redirect is left in place when there is no proxy: it is the form that
 * has always worked, and this is not the release to change it on a path
 * nobody has reported a problem with.
 */
function avatarUrl(owner: string): string {
  const name = encodeURIComponent(owner)
  return githubProxyInUse() === null
    ? `https://github.com/${name}.png?size=96`
    : githubUrl(`https://avatars.githubusercontent.com/${name}?size=96`)
}

/**
 * Row-first, two-column catalog layout. CSS Grid keeps every pair on one
 * shared table-like row and preserves the sorted DOM order. The surrounding
 * settings panel is a size container, so CSS can collapse this to one column
 * when the panel itself — rather than the browser window — gets narrow.
 */
function PluginGrid<T>({ items, render }: {
  items: T[]
  render: (item: T) => ReactNode
}) {
  return <div className={css.pluginGrid}>{items.map(render)}</div>
}

/**
 * A card's description, clamped to four lines to match the public plugin
 * directory. The reserved slot keeps each pair's footer aligned; expanding
 * one description grows the shared grid row instead of creating masonry.
 */
function CardDesc({ text, t }: { text: string; t: Translate }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    setCanExpand(el.scrollHeight > el.clientHeight + 1)
  }, [text])
  return (
    <div>
      <div ref={ref} className={expanded ? css.desc : `${css.desc} ${css.descClamp}`}>{text}</div>
      {canExpand && (
        <button
          type="button"
          className={css.descToggle}
          aria-label={expanded ? t('descCollapse') : t('descExpand')}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? <IconChevronUpOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
        </button>
      )}
    </div>
  )
}

/**
 * Full-bleed image preview, opened from a card thumbnail or a dialog's
 * screenshot strip. Not the shared Modal primitive: Modal is chrome for a
 * decision (title, description, footer actions); this is just the same
 * already-downloaded image shown bigger — there is no separate "thumbnail"
 * vs "full size" asset to fetch.
 */
function ScreenshotLightbox({ shots, startIndex, onClose, t }: { shots: string[]; startIndex: number; onClose: () => void; t: Translate }) {
  // Full-bleed previews must not auto-advance: a chart or a screenshot needs
  // to stay readable until the viewer moves on, so the carousel timer is
  // disabled with intervalMs = 0. Arrows, dots, and the keyboard still
  // navigate manually.
  const [index, setIndex] = useAutoCarousel(shots.length, startIndex, 0)
  const host = usePluginHubPortalHost()
  useEffect(() => {
    // Capture phase + stopPropagation: the Settings dialog underneath is a
    // Modal with its own Escape-to-close handling, also on window/document.
    // Without this, one Escape press closed both layers at once — verified
    // on a real host — because the modal's bubble-phase listener still fired
    // after this one. Capture runs first and this stops it from reaching
    // bubble phase at all, so only the top layer responds to one press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowLeft') { e.stopPropagation(); setIndex(index - 1) }
      else if (e.key === 'ArrowRight') { e.stopPropagation(); setIndex(index + 1) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])
  // Into a container this package owns, never into document.body itself.
  //
  // In-tree rendering is not an option: the primitives' own Modal (the
  // settings dialog underneath) portals itself to document.body, so the
  // lightbox rendered in place sat BEHIND it whatever the z-index — a portal
  // only wins a stacking tie against another portal by mounting later.
  // Reported on a real host: "大的预览图层级不对，现在在弹窗的后面".
  //
  // But sharing document.body with the host was the other half of a trap.
  // The host's settings dialog and this package are separate React roots,
  // and two roots appending and removing children of the SAME container
  // interleave in an order neither one models. The host's root then calls
  // removeChild for a node this one had already moved, React throws
  // `NotFoundError: The node to be removed is not a child of this node`, the
  // `settings.section` slot catches it, and the whole pluginhub panel goes
  // blank (#293 by @Tianhao-1017, #286, #241 — the reporter of #293 traced
  // this to the line, with the stack and a clean-reinstall check).
  //
  // Owning one container fixes that structurally: the host's root sees a
  // single opaque child it never touches, and everything this package
  // mounts or unmounts happens inside it.
  return createPortal(
    <div className={css.lightbox} onClick={onClose}>
      <button className={css.lightboxClose} aria-label={t('lightboxClose')} onClick={onClose}>
        <IconCloseOutline16 size={18} />
      </button>
      <img className={css.lightboxImg} src={shots[index]} alt="" onClick={e => e.stopPropagation()} />
      {shots.length > 1 && (
        <>
          <button
            className={`${css.lightboxNav} ${css.lightboxPrev}`}
            aria-label={t('lightboxPrev')}
            onClick={(e) => { e.stopPropagation(); setIndex(index - 1) }}
          ><IconChevronLeftOutline14 size={18} /></button>
          <button
            className={`${css.lightboxNav} ${css.lightboxNext}`}
            aria-label={t('lightboxNext')}
            onClick={(e) => { e.stopPropagation(); setIndex(index + 1) }}
          ><IconChevronRightOutline14 size={18} /></button>
          <div className={css.lightboxDots} onClick={e => e.stopPropagation()}>
            {shots.map((src, i) => (
              <span
                key={src}
                className={i === index ? `${css.lightboxDot} ${css.lightboxDotOn}` : css.lightboxDot}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        </>
      )}
    </div>,
    host,
  )
}

/**
 * The one DOM node this package portals into, created on first use and kept
 * for the life of the page.
 *
 * Created imperatively rather than rendered, and never removed: the point is
 * that `document.body`'s child list stops being shared state between two
 * React roots. A container that came and went would put the same churn back
 * into body, just less often — and "less often" is what made this bug
 * intermittent and hard to believe in the first place.
 *
 * Re-appended on every open so it stays last among body's children. That is
 * what keeps the lightbox above the host's own portalled dialog, which is
 * why the portal exists at all; moving a node we own is not something the
 * host's root tracks, so it cannot disturb it.
 */
let portalHost: HTMLElement | null = null

function pluginHubPortalHost(): HTMLElement {
  if (portalHost === null) {
    portalHost = document.createElement('div')
    // Named so anyone inspecting the DOM, or a future host wanting to give
    // plugins a real portal slot, can see who owns it.
    portalHost.setAttribute('data-dsh-pluginhub-portal', '')
  }
  return portalHost
}

/**
 * Move the container to the end of `document.body`, which is what keeps this
 * package's layers above the host's own portalled dialog.
 *
 * In a layout effect, NOT during render. `createPortal` needs the element
 * while rendering, but appending it does not belong there: React may start a
 * render, abandon it and start again, so a mutation in the render body runs
 * for passes that never commit — and this particular mutation reorders
 * `document.body`, the one container this package shares with the host's
 * separate React root. That is the same shared-child-list hazard #293 was
 * about, just arrived at from the other side. Committing it in an effect
 * means it happens once, after React is done, in the order React expects.
 */
function usePluginHubPortalHost(): HTMLElement {
  const host = pluginHubPortalHost()
  useLayoutEffect(() => {
    // appendChild on an existing child MOVES it to the end — the stacking
    // guarantee, refreshed on open without ever creating a second container.
    document.body.appendChild(host)
  }, [host])
  return host
}

/** Test hook: the container is module state and outlives a component unmount. */
export function resetPluginHubPortalHost(): void {
  portalHost?.remove()
  portalHost = null
}

/**
 * Module-scope caches so re-entering the section renders instantly instead
 * of refetching and rebuilding from a spinner (#30 by @StarsTom). Module
 * state survives section switches and is cleared when the plugin unloads.
 */
let cachedRegistry: Registry | null = null
let cachedInstalled: InstalledMap | null = null
let cachedRepoIdentities: InstalledRepoIdentities | null = null
let cachedRepoHints: InstalledRepoHints | null = null

const CATALOG_CACHE_TTL_MS = 5 * 60_000
const catalogPages = new Map<string, { data: Registry; expiresAt: number }>()
let cacheGeneration = 0

/** Release client data on plugin unload, while retaining it across section switches. */
export function resetPluginHubCache(): void {
  cacheGeneration += 1
  catalogPages.clear()
  cachedRegistry = null
  cachedInstalled = null
  cachedRepoIdentities = null
  cachedRepoHints = null
}

/** Public pluginhub protocol and the reference site's loading cadence. */
const PLUGINHUB_API_URL = 'https://dshpluginhub.com/plugins.json'
const DISCOVER_BATCH_SIZE = 12
const DISCOVER_PRELOAD_DISTANCE = 800
const PLUGINHUB_CATEGORY_IDS = ['all', 'interface', 'development', 'automation', 'knowledge', 'agent'] as const
const PLUGINHUB_SORT_IDS = ['recommended', 'updated', 'stars'] as const

function isBilingualPluginHubText(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const text = value as { zh?: unknown; en?: unknown }
  return typeof text.zh === 'string' && typeof text.en === 'string'
}

function parsePluginHubRegistry(value: unknown): Registry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the pluginhub response is not an object')
  }
  const registry = value as Partial<Registry>
  if (registry.name !== 'dsh-plugin-hub' || !Array.isArray(registry.plugins)
      || registry.categories === null || typeof registry.categories !== 'object'
      || registry.sorts === null || typeof registry.sorts !== 'object'
      || registry.pagination === undefined) {
    throw new Error('the pluginhub response does not match the public protocol')
  }
  for (const category of PLUGINHUB_CATEGORY_IDS) {
    if (!isBilingualPluginHubText(registry.categories[category])) {
      throw new Error(`the pluginhub category ${category} is missing`)
    }
  }
  for (const sort of PLUGINHUB_SORT_IDS) {
    if (!isBilingualPluginHubText(registry.sorts[sort])) {
      throw new Error(`the pluginhub sort ${sort} is missing`)
    }
  }
  const pagination = registry.pagination
  if (!Number.isSafeInteger(pagination.page) || !Number.isSafeInteger(pagination.pageSize)
      || !Number.isSafeInteger(pagination.total) || !Number.isSafeInteger(pagination.totalPages)
      || typeof pagination.hasMore !== 'boolean'
      || pagination.page < 1 || pagination.pageSize < 1 || pagination.pageSize > 48
      || (pagination.hasMore && (!Number.isSafeInteger(pagination.nextPage) || pagination.nextPage !== pagination.page + 1))) {
    throw new Error('the pluginhub pagination is invalid')
  }
  for (const [index, plugin] of registry.plugins.entries()) {
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.url !== 'string'
        || typeof plugin.category !== 'string' || plugin.category === 'all'
        || !(plugin.category in registry.categories)
        || typeof plugin.isVerified !== 'boolean' || typeof plugin.installable !== 'boolean'
        || typeof plugin.requiresBuildAuthorization !== 'boolean'
        || !['verified', 'build_required', 'pending', 'invalid'].includes(plugin.validationStatus ?? '')
        || !isBilingualPluginHubText(plugin.description)) {
      throw new Error(`the pluginhub plugin ${String(index)} is invalid`)
    }
  }
  return registry as Registry
}

function mergePluginHubPage(previous: Registry | null, page: Registry): Registry {
  if (previous === null || page.pagination?.page === 1) return page
  const seen = new Set<string>()
  const plugins = [...previous.plugins, ...page.plugins].filter(plugin => {
    const key = plugin.url.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { ...page, plugins }
}

function installedRepoIdentities(value: unknown): InstalledRepoIdentities {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const identities: InstalledRepoIdentities = {}
  for (const [name, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue
    const strings = ids.filter((id): id is string => typeof id === 'string')
    if (strings.length > 0) identities[name] = strings
  }
  return identities
}

function installedRepoHints(value: unknown): InstalledRepoHints {
  return installedRepoIdentities(value)
}

function installedMap(value: unknown): InstalledMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const installed: InstalledMap = {}
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === 'string') installed[name] = spec
  }
  return installed
}

function sameInstalledMap(left: InstalledMap, right: InstalledMap): boolean {
  const names = Object.keys(left)
  return names.length === Object.keys(right).length && names.every(name => left[name] === right[name])
}

export interface PluginHubSectionProps {
  t: Translate
  locale: {
    subscribe(callback: () => void): () => void
    getSnapshot(): { active: string }
  }
  /** Optional host-provided destination: `discover:<query>` or `installed:<query>`. */
  preferredSubsectionId?: string
}

export function PluginHubSection(props: PluginHubSectionProps) {
  const t = props.t
  const mountedCacheGeneration = useRef(cacheGeneration).current
  const localeSnap = useSyncExternalStore(
    cb => props.locale.subscribe(cb),
    () => props.locale.getSnapshot(),
  )
  const lang = pluginHubLanguage(localeSnap.active)
  const [data, setData] = useState<Registry | null>(cachedRegistry)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installed, setInstalledState] = useState<InstalledMap>(cachedInstalled ?? {})
  const setInstalled = useCallback((value: InstalledMap) => {
    if (mountedCacheGeneration !== cacheGeneration) return
    cachedInstalled = value
    setInstalledState(value)
  }, [mountedCacheGeneration])
  const [repoIdentities, setRepoIdentitiesState] = useState<InstalledRepoIdentities>(cachedRepoIdentities ?? {})
  const setRepoIdentities = useCallback((value: InstalledRepoIdentities) => {
    if (mountedCacheGeneration !== cacheGeneration) return
    cachedRepoIdentities = value
    setRepoIdentitiesState(value)
  }, [mountedCacheGeneration])
  const [repoHints, setRepoHintsState] = useState<InstalledRepoHints>(cachedRepoHints ?? {})
  const setRepoHints = useCallback((value: InstalledRepoHints) => {
    if (mountedCacheGeneration !== cacheGeneration) return
    cachedRepoHints = value
    setRepoHintsState(value)
  }, [mountedCacheGeneration])
  const [tab, setTab] = useState(() => {
    const saved = sessionStorage.getItem('dsph-tab')
    if (saved !== null) sessionStorage.removeItem('dsph-tab')
    return saved === 'installed' ? saved : 'discover'
  })
  const [q, setQ] = useState('')
  /** Per-tab searches stay independent: discover / installed. */
  const [qInstalled, setQInstalled] = useState('')
  const [installedCategory, setInstalledCategory] = useState('all')
  const [installedRegistry, setInstalledRegistry] = useState<Registry | null>(null)
  const [installedCatalogError, setInstalledCatalogError] = useState(false)
  const [installedCatalogRetry, setInstalledCatalogRetry] = useState(0)
  const [cat, setCat] = useState('all')
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  // FLAQ Desktop supplies this for onboarding/feature navigation; upstream dsh web omits it, so ordinary web opens intentionally leave this effect idle.
  useEffect(() => {
    const target = props.preferredSubsectionId
    if (target === undefined) return
    const separator = target.indexOf(':')
    const kind = separator === -1 ? target : target.slice(0, separator)
    const value = separator === -1 ? '' : target.slice(separator + 1)
    if (kind === 'installed') {
      setTab('installed')
      setQInstalled(value)
      setInstalledCategory('all')
    } else if (kind === 'discover') {
      setTab('discover')
      setCat('all')
      setVerifiedOnly(false)
      setQ(value)
      // Host navigation is an explicit destination, not keyboard input, so
      // apply it immediately instead of briefly rendering the previous
      // query during the typing debounce window.
      setCatalogQuery(value.trim())
    }
  }, [props.preferredSubsectionId])
  const [confirming, setConfirming] = useState<RegistryPlugin | null>(null)
  /** The plugin whose comment thread is open, or null. */
  const [commentsFor, setCommentsFor] = useState<RegistryPlugin | null>(null)
  /** A rejected install and the installed plugins it clashed with, one entry
   * per owner as grouped by the host. */
  interface ConflictNotice {
    plugin: RegistryPlugin
    groups: Array<{ owner: string; ids: string[] }>
  }
  /**
   * Every mutating operation the user started. Records outlive the card that
   * started them, so paginating or searching cannot take a pending decision
   * off screen.
   */
  const [records, setRecords] = useState<OperationRecord[]>([])
  const recordSeq = useRef(0)
  /** The synthetic install task rebuilt from dsph-pending after a remount. */
  const recoveredInstall = useRef<{ id: string; url: string; name?: string } | null>(null)
  /** The synthetic task rebuilt from dsph-updating after this section remounts. */
  const recoveredUpdateRecordId = useRef<string | null>(null)
  /** Raised by the card marker, so "查看详情" lands on the record itself. */
  const [operationsOpen, setOperationsOpen] = useState(false)
  const openOperations = useCallback(() => setOperationsOpen(true), [])
  /**
   * Two plugins can ship under one name from different authors, so a roster
   * row that shows only the package name cannot tell the user which of their
   * plugins a swap would uninstall. Resolve through the catalog for the
   * author and avatar a card would show, and fall back to the bare name for
   * anything installed outside it.
   */
  const describePlugin = useCallback((name: string) => {
    const entry = data?.plugins.find(plugin => plugin.npm === name || plugin.name === name)
    if (entry === undefined) return { title: name }
    return {
      title: pluginName(entry.name),
      author: entry.owner === '' ? undefined : entry.owner,
      avatar: <OwnerAvatar name={entry.name} owner={entry.owner || ''} />,
    }
  }, [data])
  /** Ids are sequential rather than random so a replayed session is stable. */
  const nextRecordId = useCallback(() => {
    recordSeq.current += 1
    return `op-${String(recordSeq.current)}`
  }, [])
  const [replacing, setReplacing] = useState(false)
  /** Shared by every screenshot source (card thumbnail, dialog strip). */
  const [lightbox, setLightbox] = useState<{ shots: string[]; index: number } | null>(null)
  const openLightbox = (shots: string[], index: number): void => setLightbox({ shots, index })
  const [busyUrl, setBusyUrl] = useState<string | null>(null)
  /** Consecutive idle polls with a pending install that never landed (#32). */
  const idleStrikes = useRef(0)
  /** Same idle-strike bookkeeping for an update whose response was lost. */
  const updateIdleStrikes = useRef(0)
  const [doneUrls, setDoneUrls] = useState<string[]>([])
  const [installError, setInstallError] = useState<string | null>(null)
  /** The notes payload the server answers with, verbatim (see /changelog). */
  type NoteRelease = { tag: string | null; name: string | null; publishedAt: string | null; url: string | null; body: string }
  type NoteCommit = { sha: string; message: string; date: string | null }
  type ResolvedNotes =
    | { kind: 'release'; release: NoteRelease }
    | { kind: 'commits'; commits: { items: NoteCommit[]; found: boolean } }
    | { kind: 'npm'; npmTimes: Array<{ version: string; date: string }> }
    | { kind: 'none' }
  interface CompatibilityNotice {
    code: 'soft-incompatible'
    risks: Array<{ plugin: string; peer: string; range: string; resolved: string; direction: string }>
    /** Cross-layer loader-name collisions this operation introduced (#230). */
    shadowedNames?: Array<{ name: string; layers: string[]; count: number }>
    /** Client bundles that no longer parse after the operation (#222). */
    brokenBundles?: Array<{ name: string; reason: string }>
    rollbackId?: string
    rollbackUnavailable?: string
  }
  const [compatibilityNotice, setCompatibilityNotice] = useState<CompatibilityNotice | null>(null)
  const [rollingBack, setRollingBack] = useState(false)
  const [updates, setUpdates] = useState<Record<string, UpdateStatus>>({})
  /** Update reminders dismissed for this host boot. The Installed tab still
   * shows these plugins and their update actions; only proactive prompts use
   * this set. */
  const [ignoredUpdateNames, setIgnoredUpdateNames] = useState<string[]>([])
  const [updatingName, setUpdatingName] = useState<string | null>(null)
  /** Update-notes dialog (#294): which row opened it, and what it resolved to. */
  const [notesFor, setNotesFor] = useState<{ name: string; current: string | null; latest: string | null; repoUrl: string | null } | null>(null)
  const [updateNotes, setUpdateNotes] = useState<ResolvedNotes | null>(null)
  const [notesState, setNotesState] = useState<'loading' | 'ready' | 'fail'>('loading')
  // Plugin blocked by pnpm's fresh-release safety wait; arms the update-now button.
  const [staleName, setStaleName] = useState<string | null>(null)
  // Local link:/file: restore: the red banner asks before swapping to the catalog.
  const [restoreName, setRestoreName] = useState<string | null>(null)

  /** Determinate percent parsed from pnpm's Progress line, when available. */
  const [progressPct, setProgressPct] = useState<number | null>(null)
  /**
   * Blocked build scripts from the last install or update: enables
   * approve-and-retry (#6; updates in #69). Exactly one of `plugin`
   * (retry installs it) / `updateName` (retry re-runs the update) is set.
   */
  const [buildsSkipped, setBuildsSkipped] = useState<{ plugin?: RegistryPlugin; updateName?: string; names: string[]; restore?: boolean } | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updatedNames, setUpdatedNames] = useState<string[]>([])
  const [hotUrls, setHotUrls] = useState<string[]>([])
  const [hotNames, setHotNames] = useState<string[]>([])
  const [progressLine, setProgressLine] = useState<string | null>(null)
  /** Per-package activation states from /dsh-pluginhub/installed + operations. */
  const [activations, setActivations] = useState<Record<string, ActivationInfo>>({})
  /** Persisted disable list, straight from /installed. */
  const [disabledNames, setDisabledNames] = useState<string[]>([])
  /** The user's own note per plugin (#347): package name → text. */
  const [notes, setNotes] = useState<Record<string, string>>({})
  /** Rows the user asked to show the AUTHOR's description on, despite a note. */
  const [showTheirs, setShowTheirs] = useState<string[]>([])
  /** The row whose note is being edited, and the text in the box. */
  const [notingName, setNotingName] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  /** The disable set as of the first load; null until it arrives. */
  const loadedDisabled = useRef<Set<string> | null>(null)
  /**
   * Patch-layer flags (port of dsh-plugin-hub): packages whose bundle rows
   * the user patch layer disables / force-enables. The UI treats them as the
   * real switch state so hand-edited cordis.patch.yml toggles are visible.
   */
  const [patchDisabledNames, setPatchDisabledNames] = useState<string[]>([])
  const [togglingName, setTogglingName] = useState<string | null>(null)
  /** Structured progress from pnpm ndjson (P1-6). */
  const [progressPhase, setProgressPhase] = useState<PluginHubStatus['phase']>(null)
  const [progressCurrent, setProgressCurrent] = useState<string | null>(null)
  const [progressDone, setProgressDone] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  /** Server-side operation lock from /dsh-pluginhub/status (#91). */
  const [hostBusy, setHostBusy] = useState(false)
  /**
   * The pluginhub's own version, shown beside the heading. Most bug reports
   * arrive as a photo of the screen, and without a version in frame the
   * first reply always has to ask which one it was.
   */
  const [version, setVersion] = useState<string | null>(null)
  /** Non-live activation results from the last operation, shown as a banner. */
  const [activationWarnings, setActivationWarnings] = useState<{ name: string; info: ActivationInfo }[]>([])
  const [hostDependencyFindings, setHostDependencyFindings] = useState<SharedHostPackageDependencyFinding[]>([])
  /** Plugin name awaiting uninstall confirmation (Modal). */
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const [removedCount, setRemovedCount] = useState(0)
  /** Toggles whose live fiber did not follow the switch — restart to apply. */
  const [toggleRestart, setToggleRestart] = useState(0)
  /** Last completed toggle, shown as a toast (#299). The switch and the row
   * tag already say the new state, but both live in a row the user may have
   * scrolled past — a mis-click there goes unnoticed. The toast is fixed on
   * screen, so it is the part that actually catches an accident. */
  const [toggled, setToggled] = useState<{ name: string; enabled: boolean } | null>(null)
  const toggledDone = useCallback(() => setToggled(null), [])
  /**
   * Dismissal of the host-reported restart notice, keyed to the current boot
   * so it reappears after a restart that did not happen and after any new
   * change. sessionStorage, not local: closing the tab is a fresh start.
   */
  const [restartNoticeDismissed, setRestartNoticeDismissed] = useState(false)
  /** Client-part plugins toggled this session — their UI needs a refresh. */
  const [refreshNames, setRefreshNames] = useState<string[]>([])
  const [envReady, setEnvReady] = useState(true)
  const [envFixing, setEnvFixing] = useState(false)
  const [envFailed, setEnvFailed] = useState(false)
  const [bootId, setBootId] = useState<string | null>(null)
  /** One-click restart (#14 by @ysyyhhh): server capability + in-flight state. */
  const [restartEnabled, setRestartEnabled] = useState(false)
  /** Supervisor the host detected around itself, when it named one (#229). */
  const [supervisor, setSupervisor] = useState<string | null>(null)
  /** Debugger latch when one-click restart must not kill the host (#447). */
  const [debuggerLatch, setDebuggerLatch] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [showTop, setShowTop] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Bundle-only plugin names from /dsh-pluginhub/installed (picker list). */
  const [installedBundles, setInstalledBundles] = useState<string[]>([])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => {
    if (scrollIdleTimer.current !== null) clearTimeout(scrollIdleTimer.current)
  }, [])
  const [loadSentinel, setLoadSentinel] = useState<HTMLDivElement | null>(null)
  const [discoverSort, setDiscoverSort] = useState<DiscoverSort>('recommended')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogNextPage, setCatalogNextPage] = useState<number | null>(cachedRegistry?.pagination?.nextPage ?? null)
  const [catalogHasMore, setCatalogHasMore] = useState(cachedRegistry?.pagination?.hasMore ?? false)
  const catalogLoadingRef = useRef(false)
  const catalogGenerationRef = useRef(0)
  const catalogAbortRef = useRef<AbortController | null>(null)
  /** Install-command disclosure inside the confirm dialog. */
  const [cmdOpen, setCmdOpen] = useState(false)
  /** Per-row "why is it not live" disclosure (installed tab). */
  const [whyOpen, setWhyOpen] = useState<string | null>(null)
  const refreshInstalled = useCallback((force?: boolean) => {
    fetch(api('/dsh-pluginhub/installed'), { cache: 'no-store' })
      .then(res => res.json())
      .then(body => {
        setInstalled(body.installed || {})
        setRepoIdentities(installedRepoIdentities(body.repoIdentities))
        setRepoHints(installedRepoHints(body.repoHints))
        if (Array.isArray(body.disabled)) {
          setDisabledNames(body.disabled)
          // The switch positions this page was BUILT with. A toggle away from
          // them needs a refresh; a toggle back to them does not, and the
          // banner has to be able to say so (#340).
          if (loadedDisabled.current === null) loadedDisabled.current = new Set(body.disabled as string[])
        }
        if (body.notes !== null && typeof body.notes === 'object' && !Array.isArray(body.notes)) {
          setNotes(body.notes as Record<string, string>)
        }
        if (Array.isArray(body.patchDisabled)) setPatchDisabledNames(body.patchDisabled)
        setInstalledBundles(Array.isArray(body.bundles) ? body.bundles.filter((name: unknown): name is string => typeof name === 'string') : [])
        if (body.activation && typeof body.activation === 'object') setActivations(body.activation)
        const findings = body.diagnostics?.schema === 'dsh-pluginhub/diagnostics/v1'
          && Array.isArray(body.diagnostics.findings)
          ? body.diagnostics.findings.filter(isHostDependencyFinding)
          : []
        setHostDependencyFindings(findings)
      })
      .catch(() => {})
    fetch(api('/dsh-pluginhub/updates') + (force === true ? '?force=1' : ''), { cache: 'no-store' })
      .then(res => res.json())
      .then(body => setUpdates(body.updates || {}))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (tab !== 'installed') return
    const controller = new AbortController()
    setInstalledCatalogError(false)
    fetch(api('/dsh-pluginhub/registry'), { cache: 'no-store', signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        const registry = body.registry as Registry | undefined
        if (!Array.isArray(registry?.plugins) || !registry.categories || typeof registry.categories !== 'object') {
          throw new Error('Invalid installed catalog')
        }
        if (!controller.signal.aborted) setInstalledRegistry(registry)
      })
      .catch(() => {
        if (!controller.signal.aborted) setInstalledCatalogError(true)
      })
    return () => controller.abort()
  }, [tab, installedCatalogRetry])

  // The full host catalog keeps installed metadata independent of whichever
  // Discover page, query or category the user last viewed.
  const installedCatalog = installedRegistry ?? data
  const installedRows = useMemo(() => Object.entries(installed)
    .filter(([name]) => name !== PLUGINHUB_PACKAGE_NAME)
    .map(([name, spec]) => {
      const entry = installedCatalog === null ? undefined
        : entryForDep(installedCatalog.plugins, name, spec, repoIdentities[name], repoHints[name])
      return { name, spec, entry, categories: entry === undefined ? [] : pluginCategories(entry) }
    }), [installed, installedCatalog, repoIdentities, repoHints])
  const installedCategoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of installedRows) {
      for (const id of row.categories.length > 0 ? row.categories : ['__uncategorized']) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    return counts
  }, [installedRows])
  const installedCategoryIds = [...new Set([
    ...Object.keys(installedCatalog?.categories ?? {}).filter(id => id !== 'all'),
    ...installedCategoryCounts.keys(),
    ...(installedCategory === '__uncategorized' ? [installedCategory] : []),
  ])]
  const installedCategoryLabel = (id: string): string => id === '__uncategorized'
    ? t('uncategorized') : pluginHubText(installedCatalog?.categories[id], lang) || id
  const filteredInstalledRows = installedRows.filter(row => {
    if (installedCategory === '__uncategorized' && row.categories.length > 0) return false
    if (installedCategory !== 'all' && installedCategory !== '__uncategorized' && !row.categories.includes(installedCategory)) return false
    const needle = qInstalled.trim().toLowerCase()
    if (needle === '') return true
    const entry = row.entry
    return [row.name, row.spec, notes[row.name], entry?.name, entry?.owner,
      entry?.description?.zh, entry?.description?.en,
      ...row.categories.flatMap(id => [id, ...Object.values(installedCatalog?.categories[id] ?? {})]),
    ].some(value => typeof value === 'string' && value.toLowerCase().includes(needle))
  })

  /** Active Bundles count as installed in Discover without becoming package-manager targets. */
  const catalogInstalled = useMemo(
    () => installedForCatalog(installed, installedBundles),
    [installed, installedBundles],
  )
  /** Lookup set for the persisted disable list (#60). */
  /** Effective switch state: pluginhub disable list ∪ user-patch-layer disables. */
  const effectiveDisabledSet = useMemo(
    () => new Set([...disabledNames, ...patchDisabledNames]),
    [disabledNames, patchDisabledNames],
  )

  const loadCatalog = useCallback(async (page = 1, force = false): Promise<void> => {
    if (page > 1 && catalogLoadingRef.current) return
    if (page === 1) {
      catalogGenerationRef.current += 1
      catalogAbortRef.current?.abort()
      // Keep the protocol metadata (category/sort labels and total count)
      // mounted while replacing the rows. This avoids a toolbar jump between
      // every filter choice without showing stale plugin cards.
      setData(previous => previous === null ? null : { ...previous, plugins: [], pagination: undefined })
      setLoadError(null)
      setCatalogNextPage(null)
      setCatalogHasMore(false)
    }
    const generation = catalogGenerationRef.current
    const currentCacheGeneration = mountedCacheGeneration
    const controller = new AbortController()
    catalogAbortRef.current = controller
    catalogLoadingRef.current = true
    const url = new URL(PLUGINHUB_API_URL)
    url.searchParams.set('category', cat)
    url.searchParams.set('sort', discoverSort)
    url.searchParams.set('verifiedOnly', String(verifiedOnly))
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', String(DISCOVER_BATCH_SIZE))
    if (catalogQuery !== '') url.searchParams.set('q', catalogQuery)
    try {
      const key = url.toString()
      const hit = catalogPages.get(key)
      let result: Registry
      if (!force && hit !== undefined && hit.expiresAt > Date.now()) {
        result = hit.data
      } else {
        const response = await fetch(key, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        result = parsePluginHubRegistry(await response.json())
      }
      if (result.pagination?.page !== page) throw new Error('the pluginhub returned an unexpected page')
      if (controller.signal.aborted || generation !== catalogGenerationRef.current || currentCacheGeneration !== cacheGeneration) return
      if (result !== hit?.data) {
        catalogPages.delete(key)
        // Bound memory when a session visits many search/filter combinations.
        if (catalogPages.size >= 100) catalogPages.delete(catalogPages.keys().next().value!)
        catalogPages.set(key, { data: result, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS })
      }
      setData(previous => {
        if (currentCacheGeneration !== cacheGeneration) return previous
        const merged = mergePluginHubPage(previous, result)
        if (cat === 'all' && discoverSort === 'recommended' && catalogQuery === '' && !verifiedOnly) cachedRegistry = merged
        return merged
      })
      setCatalogNextPage(result.pagination?.nextPage ?? null)
      setCatalogHasMore(result.pagination?.hasMore ?? false)
      setLoadError(null)
    } catch (error) {
      if (controller.signal.aborted || generation !== catalogGenerationRef.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === catalogGenerationRef.current) {
        catalogLoadingRef.current = false
      }
    }
  }, [cat, discoverSort, catalogQuery, verifiedOnly, mountedCacheGeneration])

  useEffect(() => {
    const timer = setTimeout(() => setCatalogQuery(q.trim()), 320)
    return () => clearTimeout(timer)
  }, [q])

  useEffect(() => {
    void loadCatalog(1)
  }, [loadCatalog])

  useEffect(() => () => catalogAbortRef.current?.abort(), [])

  useEffect(() => {
    fetch(api('/dsh-pluginhub/status'), { cache: 'no-store' })
      .then(res => res.json())
      .then(status => {
        setEnvReady(status.pnpm !== false)
        // Applied before anything renders a github.com URL. The catalog this
        // page draws from is a larger request through the same server, so it
        // lands later; and if it ever did not, the status poll re-renders
        // within seconds and the images correct themselves.
        setGithubProxy(typeof status.githubProxy === 'string' ? status.githubProxy : null)
        if (typeof status.boot === 'string') {
          setBootId(status.boot)
          setIgnoredUpdateNames(ignoredUpdatesForBoot(status.boot))
          // A dismissal only silences the notice for the boot it was made
          // in: if the user dismissed instead of restarting, the next boot
          // (or a stale dismissal from a previous one) shows it again.
          try {
            setRestartNoticeDismissed(sessionStorage.getItem('dsph-restart-dismissed') === status.boot)
          } catch { /* storage unavailable */ }
        }
        setRestartEnabled(status.restart === true)
        setSupervisor(typeof status.supervisor === 'string' ? status.supervisor : null)
        setDebuggerLatch(typeof status.debugger === 'string' ? status.debugger : null)
        if (typeof status.version === 'string' && status.version !== '') setVersion(status.version)
      })
      .catch(() => {})
    refreshInstalled()
  }, [refreshInstalled])

  // Pending-restart flags survive tab switches and page reloads, scoped to
  // one host process: a different boot id means the restart happened and the
  // stale banner must not resurrect.
  useEffect(() => {
    if (bootId === null) return
    const saved = readSession('dsph-restart')
    if (saved === null) return
    if (saved.boot !== bootId) {
      sessionStorage.removeItem('dsph-restart')
      return
    }
    if (Array.isArray(saved.doneUrls) && saved.doneUrls.length > 0) setDoneUrls(saved.doneUrls)
    if (Array.isArray(saved.updated) && saved.updated.length > 0) setUpdatedNames(saved.updated)
    if (typeof saved.removed === 'number' && saved.removed > 0) setRemovedCount(saved.removed)
    if (typeof saved.toggled === 'number' && saved.toggled > 0) setToggleRestart(saved.toggled)
  }, [bootId])

  useEffect(() => {
    if (bootId === null) return
    if (doneUrls.length === 0 && updatedNames.length === 0 && removedCount === 0 && toggleRestart === 0) {
      // Nothing pending: drop any stale entry (e.g. a hot mount cleared the
      // only doneUrl) so a same-boot remount cannot resurrect the banner (#73).
      sessionStorage.removeItem('dsph-restart')
      return
    }
    sessionStorage.setItem('dsph-restart', JSON.stringify({
      boot: bootId,
      doneUrls,
      updated: updatedNames,
      removed: removedCount,
      toggled: toggleRestart,
    }))
  }, [bootId, doneUrls, updatedNames, removedCount, toggleRestart])

  const fixEnv = useCallback(() => {
    setEnvFixing(true)
    setEnvFailed(false)
    fetch(api('/dsh-pluginhub/setup-pnpm'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(res => res.json())
      .then(body => {
        if (body.ok) {
          setEnvReady(true)
        } else {
          setEnvFailed(true)
          if (typeof body.error === 'string') setInstallError(body.error)
        }
      })
      .catch(() => setEnvFailed(true))
      .finally(() => setEnvFixing(false))
  }, [])

  // Recover an install whose HTTP response was lost (page navigated away or
  // the connection dropped): the pending marker survives in sessionStorage and
  // the poll below converges the button state from the host's ground truth.
  useEffect(() => {
    const pending = readSession('dsph-pending')
    if (pending !== null && typeof pending.url === 'string') {
      setBusyUrl(pending.url)
      recoveredInstall.current = {
        id: `recovered-install:${pending.url}`,
        url: pending.url,
        ...(typeof pending.name === 'string' && pending.name !== '' ? { name: pending.name } : {}),
      }
    }
    // Same recovery for an update in flight: closing the config page unmounts
    // this section and drops `updatingName` with it, so the running row's
    // progress vanished on reopen. The marker restores the row and the poll
    // below converges it from the host's ground truth.
    const updating = readSession('dsph-updating')
    if (updating !== null && typeof updating.name === 'string' && updating.name !== '') {
      setUpdatingName(updating.name)
      const id = `recovered-update:${updating.name}`
      recoveredUpdateRecordId.current = id
      setRecords(list => list.some(record =>
        record.kind === 'update' && record.name === updating.name && record.state === 'running')
        ? list
        : enqueue(list, { id, kind: 'update', name: updating.name, state: 'running' }))
    }
  }, [])

  // New markers carry the name and recover immediately. Older markers only
  // carried the URL, so wait for the catalog and resolve the same task from it.
  useEffect(() => {
    const recovered = recoveredInstall.current
    if (recovered === null) return
    const name = recovered.name ?? data?.plugins.find(plugin => plugin.url === recovered.url)?.name
    if (name === undefined) return
    recovered.name = name
    setRecords(list => list.some(record => record.id === recovered.id)
      ? list
      : enqueue(list, {
          id: recovered.id, kind: 'install', name, url: recovered.url, state: 'running',
        }))
  }, [data])

  useEffect(() => {
    if (busyUrl === null && updatingName === null) {
      // `hostBusy` is sampled by the progress poll. A normal update response
      // can settle the local operation before the next poll observes the
      // route lock released, leaving the restart button disabled until this
      // section remounts (#440). With no tracked install/update left, discard
      // that stale sample; the guarded restart route still handles the small
      // post-response lock-release window with its existing 409 retry.
      setHostBusy(false)
      setProgressLine(null)
      setProgressPhase(null)
      setProgressCurrent(null)
      setProgressDone(0)
      setCancelling(false)
      return
    }
    const timer = setInterval(() => {
      fetch(api('/dsh-pluginhub/status'), { cache: 'no-store' })
        .then(res => res.json())
        .then(status => {
          setHostBusy(status.busy === true)
          setDebuggerLatch(typeof status.debugger === 'string' ? status.debugger : null)
          if (status.active) {
            setCancelling(status.cancelling === true)
            if (status.phase !== null && status.phase !== undefined) {
              // Structured pnpm progress: stage + current package + count.
              setProgressPhase(status.phase)
              setProgressCurrent(status.currentPackage ?? null)
              setProgressDone(status.done ?? 0)
              setProgressLine(null)
              if (typeof status.size === 'number' && status.size > 0 && typeof status.downloaded === 'number') {
                setProgressPct(Math.max(4, Math.min(96, Math.round(status.downloaded / status.size * 100))))
              }
            } else {
              setProgressLine((status.lastLine || '…') + '  (' + status.seconds + 's)')
              setProgressPhase(null)
              setProgressCurrent(null)
              setProgressDone(0)
              const m = /resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/.exec(status.lastLine || '')
              if (m !== null && Number(m[1]) > 0) {
                const done = Number(m[2]) + Number(m[3]) + Number(m[4])
                setProgressPct(Math.max(4, Math.min(96, Math.round(done / Number(m[1]) * 100))))
              }
            }
          } else {
            setProgressLine(null)
            setProgressPct(null)
            setProgressPhase(null)
            setProgressCurrent(null)
            setProgressDone(0)
            setCancelling(false)
            const statusInstalled = installedMap(status.installed)
            if (!sameInstalledMap(installed, statusInstalled)) refreshInstalled()
            const pending = readSession('dsph-pending')
            // status.busy (#91): pnpm exited but the install route still
            // holds the operation lock (validation, hot-mount). Neither
            // declare the install done nor count an idle strike yet — a
            // premature banner here invited a restart click into a 409.
            if (pending !== null && busyUrl !== null && status.busy !== true) {
              const nowInstalled = data !== null && data.plugins.some(p =>
                p.url === busyUrl && isInstalled(p, statusInstalled, repoIdentities, data.plugins, repoHints))
              if (nowInstalled) {
                idleStrikes.current = 0
                sessionStorage.removeItem('dsph-pending')
                const recovered = recoveredInstall.current
                if (recovered !== null) {
                  setRecords(list => drop(list, recovered.id))
                  recoveredInstall.current = null
                }
                setDoneUrls(urls => urls.includes(busyUrl) ? urls : urls.concat(busyUrl))
                setBusyUrl(null)
              } else if (++idleStrikes.current >= 2) {
                // Host is idle and the plugin never landed: the install died
                // (e.g. exit 127) with its response lost. Without this the
                // button says "installing" forever — across reloads (#32).
                idleStrikes.current = 0
                sessionStorage.removeItem('dsph-pending')
                const recovered = recoveredInstall.current
                if (recovered !== null) {
                  setRecords(list => drop(list, recovered.id))
                  recoveredInstall.current = null
                }
                setBusyUrl(null)
                setInstallError(t('installFail'))
              }
            }
            // An update whose response was lost — the page was closed mid-run
            // and reopened via the dsph-updating marker — converges the same
            // way. Once the host reports the operation fully settled (pnpm
            // exited AND the mutation lock released), hand the running row
            // back to the refreshed listing instead of showing "updating"
            // forever. Two idle polls guard the brief window before the host
            // has actually started the command.
            if (updatingName !== null && status.busy !== true) {
              if (++updateIdleStrikes.current >= 2) {
                updateIdleStrikes.current = 0
                sessionStorage.removeItem('dsph-updating')
                const recoveredId = recoveredUpdateRecordId.current
                if (recoveredId !== null) {
                  setRecords(list => drop(list, recoveredId))
                  recoveredUpdateRecordId.current = null
                }
                setUpdatingName(null)
                refreshInstalled()
              }
            } else {
              updateIdleStrikes.current = 0
            }
          }
        })
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [busyUrl, updatingName, data, installed, repoIdentities, repoHints, refreshInstalled])

  // The .body scroller is shared across top tabs AND in-tab list replacements
  // (Discover category/search/sort; Installed category/search).
  // Leaving scrollTop in place opens the next list mid-page — or, when it is
  // shorter, at its clamped bottom. Instant (not the smooth scrollToTop used
  // for pagination) so the jump happens before paint.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el !== null) el.scrollTop = 0
    setShowTop(false)
  }, [tab, q, cat, discoverSort, verifiedOnly, qInstalled, installedCategory])

  const plugins = data?.plugins ?? []
  const hasMorePlugins = catalogHasMore && catalogNextPage !== null

  useEffect(() => {
    if (loadSentinel === null || !hasMorePlugins || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        if (catalogNextPage !== null) void loadCatalog(catalogNextPage)
      },
      { root: bodyRef.current, rootMargin: `${DISCOVER_PRELOAD_DISTANCE}px 0px` },
    )
    observer.observe(loadSentinel)
    return () => observer.disconnect()
  }, [loadSentinel, hasMorePlugins, catalogNextPage, loadCatalog])

  const doRollback = useCallback((rollbackId: string) => {
    setRollingBack(true)
    setInstallError(null)
    fetch(api('/dsh-pluginhub/rollback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rollbackId }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          setCompatibilityNotice(null)
          refreshInstalled()
        } else {
          setInstallError(String(body.error || body.detail || 'rollback failed'))
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setRollingBack(false))
  }, [refreshInstalled])

  const compatibilitySummary = (risks: CompatibilityNotice['risks']): string => {
    if (risks.length === 0) return ''
    const first = risks[0]
    return `${first.plugin}: ${first.peer} ${first.range} vs ${first.resolved}`
  }

  /** Which name now resolves from two layers, and which layers those are. */
  const shadowSummary = (entries: NonNullable<CompatibilityNotice['shadowedNames']>): string => {
    if (entries.length === 0) return ''
    const first = entries[0]
    const rest = entries.length > 1 ? ` (+${entries.length - 1})` : ''
    return `${first.name} — ${first.layers.join(' / ')}${rest}`
  }

  const doInstall = useCallback((plugin: RegistryPlugin) => {
    setBuildsSkipped(null)
    setConfirming(null)
    setInstallError(null)
    setActivationWarnings([])
    setBusyUrl(plugin.url)
    // One record per attempt. A retry appends rather than reusing the old
    // one, so the card resolves to the newest and its Install button returns.
    const recordId = nextRecordId()
    setRecords(list => enqueue(list, {
      id: recordId, kind: 'install', name: plugin.name, url: plugin.url, state: 'running',
    }))
    sessionStorage.setItem('dsph-pending', JSON.stringify({ url: plugin.url, name: plugin.name }))
    fetch(api('/dsh-pluginhub/install'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: plugin.url }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        setBusyUrl(null)
        sessionStorage.removeItem('dsph-pending')
        if (body.cancelled === true) {
          // User-cancelled: quiet reset, nothing to report.
          setRecords(list => drop(list, recordId))
          refreshInstalled()
          if (body.partial === true) setInstallError(t('partialNote'))
          return
        }
        if (status === 200 && body.ok) {
          sessionStorage.setItem('dsph-tab', 'installed')
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
            const warns = Object.entries(body.activation as Record<string, ActivationInfo>)
              .filter(([, info]) => info.state !== 'live' && info.state !== 'missing')
              .map(([name, info]) => ({ name, info }))
            setActivationWarnings(warns)
          }
          if (body.hot) {
            // The status-poll recovery path may have already counted this URL
            // as pending-restart before the install response confirmed a hot
            // mount; a hot plugin must not stay in doneUrls (#73).
            setDoneUrls(urls => urls.filter(url => url !== plugin.url))
            setHotUrls(urls => urls.includes(plugin.url) ? urls : urls.concat(plugin.url))
            setHotNames(names => names.includes(plugin.name) ? names : names.concat(plugin.name))
          } else {
            setDoneUrls(urls => urls.includes(plugin.url) ? urls : urls.concat(plugin.url))
          }
          if (body.compatibility?.code === 'soft-incompatible') {
            setCompatibilityNotice(body.compatibility as CompatibilityNotice)
          }
          // `warned` keeps the ✓: the plugin IS installed, so calling a
          // compatibility risk a failure would misreport what happened.
          setRecords(list => patchRecord(list, recordId, body.compatibility?.code === 'soft-incompatible'
            ? { state: 'warned', reason: t('compatRiskBanner') }
            : { state: 'done', needsRefresh: body.hot !== true }))
          refreshInstalled()
        } else {
          if (status === 409) {
            const busyReason = body.agentsBusy === true
              ? t('agentBusyInstall') + (Array.isArray(body.runningAgents) && body.runningAgents.length > 0 ? ` (${body.runningAgents.join(', ')})` : '')
              : t('busyWait')
            setRecords(list => patchRecord(list, recordId, { state: 'failed', reason: busyReason }))
            setOperationsOpen(true)
            return
          }
          // A clash is not a failure to report and forget: the host already
          // reverted it, so what remains is a decision. `input` keeps the
          // record in the panel until the user answers it.
          if (Array.isArray(body.conflictGroups) && body.conflictGroups.length > 0) {
            setRecords(list => patchRecord(list, recordId, {
              state: 'input', conflicts: body.conflictGroups as ConflictNotice['groups'],
            }))
            // Raise the panel for anything that needs an answer. A red dot on
            // a closed panel is not a report; out of sight is out of mind.
            setOperationsOpen(true)
            return
          }
          const blocked = Array.isArray(body.ignoredBuilds) ? body.ignoredBuilds.map(String) : []
          if (blocked.length > 0) setBuildsSkipped({ plugin, names: blocked })
          const text = (v: unknown) => typeof v === 'string' ? v : (v && typeof (v as any).text === 'string') ? (v as any).text : v == null ? '' : JSON.stringify(v)
          const orphans = Array.isArray(body.orphanBundles) ? body.orphanBundles.map(String) : []
          const failure = text(body.error) || humanOutput([text(body.stderr), text(body.stdout)].filter(Boolean).join('\n')) || ('exit ' + body.exitCode)
          // The profile will not boot as it stands (#339). Said FIRST, because
          // it outranks whatever else went wrong: a plugin that failed to
          // install is recoverable, a profile that cannot start is not — and
          // the user would otherwise meet it as a Node stack trace after the
          // next restart, with nothing linking it to this operation.
          // A stale catalog entry (#346) is said before pnpm's own wording,
          // which for that failure reads like the user broke something.
          const staleEntry = typeof body.staleEntry === 'string' ? body.staleEntry : null
          const detail = [
            orphans.length > 0 ? `${t('orphanBundle')} ${orphans.join(', ')}` : null,
            staleEntry,
            failure,
          ].filter(Boolean).join('\n')
          // Carry the blocked names onto the record too: the panel is where
          // this failure is read, so it is where the one-click way out has to
          // be (#314).
          setRecords(list => patchRecord(list, recordId, {
            state: 'failed', reason: detail.trim().slice(-600),
            ...(blocked.length > 0 ? { blockedBuilds: blocked } : {}),
          }))
          setOperationsOpen(true)
        }
      })
      .catch(() => {
        // #100: a long install can outlive its HTTP response (loopback
        // stacks and proxies reset idle connections) while pnpm keeps
        // working server-side — declaring failure here produced a false
        // "install failed, export the log" with an EMPTY log (the route
        // only logs when it finishes), followed by the plugin quietly
        // appearing minutes later. Keep dsph-pending and the busy button
        // instead, and let the status poll decide: its recovery path marks
        // success once the plugin lands (busy-aware since #91) and strikes
        // out genuinely dead installs (#32).
      })
  }, [nextRecordId, refreshInstalled, t])

  /**
   * Resolve a loader-id clash the only way one profile allows: uninstall the
   * plugins holding the ids, then retry the install. Sequential because each
   * route takes the host's mutation lock, so a parallel burst would 409.
   *
   * A failure part-way leaves plugins already gone. Nothing reinstalls them
   * automatically (a rollback would itself be an install that can fail), so
   * the message names them — reporting only "failed" would leave the user
   * guessing which of their plugins survived.
   */
  const doReplace = useCallback(async (record: OperationRecord, plugin: RegistryPlugin) => {
    setInstallError(null)
    setReplacing(true)
    const removed: string[] = []
    try {
      for (const group of record.conflicts ?? []) {
        const response = await fetch(api('/dsh-pluginhub/uninstall'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: group.owner }),
        })
        const body = await response.json() as { ok?: boolean; error?: unknown; stderr?: unknown }
        if (response.status !== 200 || body.ok !== true) {
          const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
          const detail = (text(body.error) || humanOutput(text(body.stderr)) || 'error').trim().slice(-400)
          const reason = removed.length === 0
            ? `${t('installFail')}: ${group.owner} — ${detail}`
            : `${t('conflictReplaceFailed')} ${removed.join(', ')} — ${detail}`
          setRecords(list => patchRecord(list, record.id, { state: 'failed', conflicts: undefined, reason }))
          setOperationsOpen(true)
          refreshInstalled()
          return
        }
        removed.push(group.owner)
      }
    } finally {
      setReplacing(false)
    }
    // The clash record is done with; the retry opens its own, so the card
    // resolves to the new attempt rather than the answered decision.
    setRecords(list => drop(list, record.id))
    refreshInstalled()
    doInstall(plugin)
  }, [doInstall, refreshInstalled, t])

  /**
   * Answer a clash. `keep` is not a no-op to skip: it is the user declining
   * the install, so the record retires rather than lingering as unanswered.
   */
  const resolveConflict = useCallback((record: OperationRecord, choice: 'keep' | 'swap') => {
    if (choice === 'keep') {
      setRecords(list => patchRecord(list, record.id, {
        state: 'failed', conflicts: undefined, reason: t('conflictDeclined'),
      }))
      return
    }
    const plugin = data?.plugins.find(candidate => candidate.url === record.url)
    if (plugin === undefined) return
    void doReplace(record, plugin)
  }, [data, doReplace, t])

  /**
   * Restart the host and reload once the boot id changes (#14 by @ysyyhhh).
   * The 202 races the process's SIGTERM, so network errors on the initial
   * request are expected and treated as "restart under way".
   */
  const doRestart = useCallback(() => {
    if (bootId === null || restarting) return
    const previousBoot = bootId
    setRestarting(true)
    setInstallError(null)
    const awaitNewBoot = () => {
      const deadline = Date.now() + 60000
      const poll = () => {
        fetch(api('/dsh-pluginhub/status'), { cache: 'no-store' })
          .then(res => res.json())
          .then((next) => {
            if (typeof next.boot === 'string' && next.boot !== previousBoot) {
              location.reload()
              return
            }
            retry()
          })
          .catch(retry)
      }
      const retry = () => {
        if (Date.now() > deadline) {
          setRestarting(false)
          setInstallError(t('restartTimeout'))
          return
        }
        setTimeout(poll, 1500)
      }
      poll()
    }
    const requestRestart = (attemptsLeft: number) => {
      fetch(api('/dsh-pluginhub/restart'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(res => res.json().then(body => ({ status: res.status, body })))
        .then(({ status, body }) => {
          if (status === 202 && body.ok === true) {
            awaitNewBoot()
            return
          }
          // 409 = the install route still holds the operation lock for its
          // post-processing (#91) — a short quiet retry beats surfacing
          // "cannot restart while a plugin operation is running" to a user
          // who just followed our own banner.
          if (status === 409 && attemptsLeft > 0) {
            setTimeout(() => requestRestart(attemptsLeft - 1), 1500)
            return
          }
          setRestarting(false)
          setInstallError(t('restartFail') + ': ' + String(body.error || ('HTTP ' + String(status))))
        })
        .catch(awaitNewBoot) // the host may die mid-response; keep polling
    }
    requestRestart(10)
  }, [bootId, restarting, t])

  /** Cancel the running plugin command (#6 by @qichuang321). */
  const doCancel = useCallback(() => {
    fetch(api('/dsh-pluginhub/cancel'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .catch(() => {})
  }, [])

  const doUpdate = useCallback((name: string, force = false, restore = false) => {
    setInstallError(null)
    setActivationWarnings([])
    // Only THIS row's stale marker is cleared. "Update all" walks the list
    // calling straight into here, so an unconditional reset meant every
    // earlier release-age failure lost its retry button and only the last
    // one kept it — the rest failed silently with no way forward (#255).
    setStaleName(prev => (prev === name ? null : prev))
    setRestoreName(prev => (prev === name ? null : prev))
    setUpdatingName(name)
    updateIdleStrikes.current = 0
    // Mirror the install flow's dsph-pending marker: closing the config page
    // unmounts this section and drops `updatingName`, so the running row's
    // progress was lost on reopen. The marker survives the unmount and lets a
    // reopen restore the row while the status poll converges the outcome.
    sessionStorage.setItem('dsph-updating', JSON.stringify({ name }))
    // The Tasks panel exists to answer "what is running right now", and an
    // update is one of the things that runs. `OperationKind` has carried
    // 'update' since the panel was written; only the enqueue was missing, so
    // "update all" left the panel empty while several plugins were mid-flight
    // (#295 by @sanyecao88). One record per attempt, like the install flow.
    const updateRecordId = nextRecordId()
    setRecords(list => enqueue(list, { id: updateRecordId, kind: 'update', name, state: 'running' }))
    return fetch(api('/dsh-pluginhub/update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...(force ? { force: true } : {}), ...(restore ? { restore: true } : {}) }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        // A response means the host settled the request (even a 4xx/5xx), so
        // the running row can hand back now. Only a lost response keeps the
        // marker + row for the poll to converge.
        sessionStorage.removeItem('dsph-updating')
        setUpdatingName(null)
        if (body.cancelled === true) {
          setRecords(list => drop(list, updateRecordId))
          refreshInstalled()
          if (body.partial === true) setInstallError(t('partialNote'))
          return
        }
        if (status === 200 && body.ok) {
          setRecords(list => patchRecord(list, updateRecordId, { state: 'done' }))
          setUpdatedNames(names => names.concat(name))
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
          }
          if (body.compatibility?.code === 'soft-incompatible') {
            setCompatibilityNotice(body.compatibility as CompatibilityNotice)
          }
          refreshInstalled()
        } else {
          if (status === 409) {
            if (body.agentsBusy === true) {
              const running = Array.isArray(body.runningAgents) && body.runningAgents.length > 0 ? ` (${body.runningAgents.join(', ')})` : ''
              setRecords(list => patchRecord(list, updateRecordId, { state: 'failed', reason: t('agentBusyUpdate') + running }))
              setInstallError(t('agentBusyUpdate') + running)
              return
            }
            setRecords(list => patchRecord(list, updateRecordId, { state: 'failed', reason: t('busyWait') }))
            setInstallError(t('busyWait'))
            return
          }
          if (body.stale === true) setStaleName(name)
          // Blocked build scripts during an update (#69): same
          // approve-and-retry banner as the install flow, retrying the update.
          if (Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0) {
            setBuildsSkipped({ updateName: name, names: body.ignoredBuilds.map(String), restore })
          }
          const text = (v: unknown) => typeof v === 'string' ? v : (v && typeof (v as any).text === 'string') ? (v as any).text : v == null ? '' : JSON.stringify(v)
          const orphans = Array.isArray(body.orphanBundles) ? body.orphanBundles.map(String) : []
          const failure = text(body.error) || humanOutput([text(body.stderr), text(body.stdout)].filter(Boolean).join('\n')) || ('exit ' + body.exitCode)
          // The profile will not boot as it stands (#339). Said FIRST, because
          // it outranks whatever else went wrong: a plugin that failed to
          // install is recoverable, a profile that cannot start is not — and
          // the user would otherwise meet it as a Node stack trace after the
          // next restart, with nothing linking it to this operation.
          // A stale catalog entry (#346) is said before pnpm's own wording,
          // which for that failure reads like the user broke something.
          const staleEntry = typeof body.staleEntry === 'string' ? body.staleEntry : null
          const detail = [
            orphans.length > 0 ? `${t('orphanBundle')} ${orphans.join(', ')}` : null,
            staleEntry,
            failure,
          ].filter(Boolean).join('\n')
          setRecords(list => patchRecord(list, updateRecordId, { state: 'failed', reason: detail.trim().slice(-600) }))
          setInstallError((restore ? t('restoreFail') : t('updateFail')) + ': ' + name + ' — ' + detail.trim().slice(-600))
        }
      })
      .catch(() => {
        // A lost response does not mean the update stopped (the route holds
        // its reply until pnpm finishes, #100): keep the marker AND the
        // running row, and let the status poll converge the outcome instead
        // of declaring a false failure — mirroring the install flow's catch.
      })
  }, [refreshInstalled, t])

  const askRestore = useCallback((name: string) => {
    const spec = installed[name]
    const entry = data === null || spec === undefined
      ? undefined
      : entryForDep(data.plugins, name, String(spec), repoIdentities[name], repoHints[name])
    setStaleName(null)
    if (entry === undefined) {
      setRestoreName(null)
      setInstallError(t('restoreNoCatalog'))
      return
    }
    setRestoreName(name)
    setInstallError(t('restoreHint'))
  }, [data, installed, repoHints, repoIdentities, t])

  /** Open the update-notes dialog and start its fetch. Lazy: the request only
      exists while a user is actually looking at one plugin's notes, and
      closing the dialog abandons the render — the server side caches the
      payload, so reopening is cheap. */
  const openNotes = useCallback((name: string, current: string | null, latest: string | null, repoUrl: string | null) => {
    setNotesFor({ name, current, latest, repoUrl })
    setUpdateNotes(null)
    setNotesState('loading')
    fetch(`${api('/dsh-pluginhub/changelog')}?name=${encodeURIComponent(name)}`)
      .then(res => res.json())
      .then(body => { setUpdateNotes(body as ResolvedNotes); setNotesState('ready') })
      .catch(() => setNotesState('fail'))
  }, [])

  /**
   * Forget a pending page-refresh for a plugin that is no longer here.
   *
   * The banner counts what the page has not caught up with. Install then
   * uninstall and the page is level again — there is nothing left to load —
   * but both sets were append-only, so it kept asking for a refresh that
   * would show nothing (#340). It conflated "something needs doing" with
   * "something happened in this session".
   */
  /** Write (or clear, when empty) this plugin's note. */
  const saveNote = useCallback((name: string, text: string) => {
    setNotingName(null)
    fetch(api('/dsh-pluginhub/note'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, text }),
    })
      .then(res => res.json())
      .then((body) => {
        if (body.ok && body.notes !== null && typeof body.notes === 'object') {
          setNotes(body.notes as Record<string, string>)
        } else setInstallError(String(body.error || 'note failed'))
      })
      .catch(error => setInstallError(String(error)))
  }, [])

  const clearPendingRefresh = useCallback((name: string) => {
    setHotNames(names => names.filter(entry => entry !== name))
    setRefreshNames(names => names.filter(entry => entry !== name))
  }, [])

  const doUninstall = useCallback((name: string) => {
    setRemoveConfirm(null)
    setInstallError(null)
    setActivationWarnings([])
    setRemovingName(name)
    return fetch(api('/dsh-pluginhub/uninstall'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          if (!body.hot) setRemovedCount(n => n + 1)
          // A client-part plugin stays injected until a page reload — the same
          // pending-refresh banner as enable/disable tells the user to reload,
          // instead of silently leaving the uninstalled plugin's UI running.
          //
          // But only when it was live in THIS page. A plugin installed during
          // this session was never injected: the banner was asking the user to
          // reload in order to GET it, so undoing the install nets to zero and
          // the banner must go (#340 — "it was reporting session history, not
          // pending work"). Being already pending is exactly what distinguishes
          // the two, and the server cannot see it: `refresh` says the package
          // HAD a client part, not that this page ever loaded it.
          const neverLoadedHere = hotNames.includes(name) || refreshNames.includes(name)
          if (body.refresh === true && !neverLoadedHere) {
            setRefreshNames(names => names.includes(name) ? names : names.concat(name))
          } else clearPendingRefresh(name)
          refreshInstalled()
        } else {
          if (body.cancelled === true) {
            refreshInstalled()
            if (body.partial === true) setInstallError(t('partialNote'))
            return
          }
          // Half-uninstall reconcile: the package is gone and the server has
          // already converged the manifest to disk truth. Refresh so the card
          // leaves the list instead of luring the user into a retry that
          // would 400 on "not installed"; the note separates the outcome
          // (removed, profile synced) from the process (pnpm errored).
          if (body.reconciled === true) {
            if (!body.hot) setRemovedCount(n => n + 1)
            clearPendingRefresh(name)
            refreshInstalled()
            setInstallError(t('reconciledNote'))
            return
          }
          const text = (v: unknown) => typeof v === 'string' ? v : (v && typeof (v as any).text === 'string') ? (v as any).text : v == null ? '' : JSON.stringify(v)
          setInstallError((text(body.error) || humanOutput(text(body.stderr)) || 'error').trim().slice(-600))
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setRemovingName(null))
    // hotNames/refreshNames are read above to tell a plugin this page loaded
    // from one installed inside it, so they belong in the closure.
  }, [refreshInstalled, hotNames, refreshNames])

  /** Live enable/disable of one installed plugin (#60). */
  const doToggle = useCallback((name: string, enabled: boolean) => {
    setTogglingName(name)
    setInstallError(null)
    return fetch(api('/dsh-pluginhub/toggle'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, enabled }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          if (Array.isArray(body.disabled)) setDisabledNames(body.disabled)
          if (body.activation && typeof body.activation === 'object') {
            setActivations(prev => ({ ...prev, ...body.activation }))
          }
          // A toggle whose fiber did not follow the switch joins the
          // pending-restart banner (same path as installs/updates/removals).
          if (body.restart === true) setToggleRestart(n => n + 1)
          // A client-part plugin's UI is already in the page — refresh to
          // show the change (mirrors the install hot banner).
          // Back to the position the page was rendered with means there is
          // nothing left for a refresh to show, so the banner drops it
          // instead of counting the round trip as a pending change (#340).
          if (body.refresh === true) {
            const wasDisabled = loadedDisabled.current?.has(name) ?? false
            if (wasDisabled === !enabled) clearPendingRefresh(name)
            else setRefreshNames(names => names.includes(name) ? names : names.concat(name))
          }
          setToggled({ name, enabled })
          refreshInstalled()
        } else {
          const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)
          // The server's bilingual reason (e.g. host cannot hot-mount —
          // restart required) beats the generic failure line.
          setInstallError(text(body.reason) || text(body.error) || t('toggleFail'))
          // The durable state (state.json + patch layer) was still written,
          // so a restart applies it even though the live drive failed.
          if (body.restart === true) setToggleRestart(n => n + 1)
          if (body.refresh === true) setRefreshNames(names => names.includes(name) ? names : names.concat(name))
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setTogglingName(null))
  }, [clearPendingRefresh, refreshInstalled, t])

  /** Approve the build scripts pnpm refused, then rerun what was blocked. */
  const approveAndRetry = useCallback((
    names: string[],
    resume: () => void,
  ) => {
    fetch(api('/dsh-pluginhub/approve-builds'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packages: names }),
    })
      .then(res => res.json())
      .then((body) => {
        if (!body.ok) setInstallError(String(body.error || 'approve failed'))
        else resume()
      })
      .catch(error => setInstallError(String(error)))
  }, [])

  // The pluginhub itself stays out of the batch: its update reloads this page
  // mid-run, which would strand the remaining items.
  const selfName = PLUGINHUB_PACKAGE_NAME
  const updatableNames = Object.keys(installed).filter(
    name => name !== selfName && !updatedNames.includes(name) && updates[name] && updates[name].updateAvailable,
  )
  // Replacing a local source with its catalog source is deliberately not a
  // batch update: every such plugin has an existing, explicit confirmation
  // gate because the source switch cannot be rolled back.
  const batchUpdatableNames = updatableNames.filter(name => updates[name]?.restoreRequired !== true)
  const ignoredUpdateSet = useMemo(() => new Set(ignoredUpdateNames), [ignoredUpdateNames])
  const reminderUpdatableNames = updatableNames.filter(name => !ignoredUpdateSet.has(name))
  const reminderBatchUpdatableNames = batchUpdatableNames.filter(name => !ignoredUpdateSet.has(name))
  const selfUpdateAvailable = updates[selfName]?.updateAvailable === true && !updatedNames.includes(selfName)
  const reminderUpdateNames = [
    ...(selfUpdateAvailable ? [selfName] : []),
    ...updatableNames,
  ].filter(name => !ignoredUpdateSet.has(name))
  // The pluginhub manages itself from its own settings card (Settings → Plugins
  // → Plugin configuration), not as a row here — listing it in both places
  // read as two different controls for the same thing.
  const installedOtherCount = Object.keys(installed).filter(name => name !== selfName).length

  const ignoreUpdateNotices = useCallback((names: string[]) => {
    if (bootId === null || names.length === 0) return
    setIgnoredUpdateNames(current => {
      const next = [...new Set([...current, ...names])]
      try {
        sessionStorage.setItem(IGNORED_UPDATES_SESSION_KEY, JSON.stringify({ boot: bootId, names: next }))
      } catch { /* storage unavailable: keep the dismissal for this mount */ }
      return next
    })
  }, [bootId])

  const doUpdateAll = useCallback(() => {
    const names = reminderBatchUpdatableNames.slice()
    setUpdatingAll(true)
    const next = () => {
      const name = names.shift()
      if (name === undefined) {
        setUpdatingAll(false)
        return
      }
      doUpdate(name).then(next, next)
    }
    next()
  }, [reminderBatchUpdatableNames, doUpdate])

  const sessionPendingRestart = doneUrls.length + updatedNames.length + removedCount + toggleRestart
  /**
   * Plugins the HOST reports as restart-pending, independent of what this
   * browser session happens to remember. Installing and then reloading the
   * page used to leave no restart affordance at all: the banner is built
   * from session state, while the Installed tab only says "activates on
   * restart" in passing — so the user was told a restart was needed and
   * given nothing to press. Dismissible, because a standing banner nobody
   * wants to act on right now is just noise (it returns next session, or
   * as soon as another change lands).
   */
  const hostPendingNames = Object.keys(activations).filter(name => activations[name]?.state === 'restart')
  const showHostPending = hostPendingNames.length > 0 && !restartNoticeDismissed && sessionPendingRestart === 0
  const pendingRestart = sessionPendingRestart > 0 ? sessionPendingRestart : (showHostPending ? hostPendingNames.length : 0)
  // Self-update lives in the header button and the settings card, not this
  // tab's row list (the pluginhub itself is filtered out below) — so a pending
  // self-update alone must not light up a dot pointing at an empty-looking tab.
  const hasUpdates = reminderUpdatableNames.length > 0

  /** Live status line: structured phase, or the human-line fallback. */
  const phasePart = progressPhase != null
    ? phaseLabel(progressPhase, t)
      + (progressCurrent !== null ? ' · ' + progressCurrent : '')
      + (progressDone > 0 ? ' · ' + t('packagesDone').replace('{0}', String(progressDone)) : '')
    : progressLine || t('progressHint')
  const progressText = cancelling ? t('cancelling') + ' · ' + phasePart : phasePart

  /** The catalog entry a deprecated plugin's `replacement` names, if any. */
  const replacementOf = (p: RegistryPlugin): RegistryPlugin | undefined =>
    p.deprecated === true && p.replacement !== undefined
      ? data?.plugins.find(r => r.name === p.replacement)
      : undefined

  const pluginCard = (p: RegistryPlugin) => {
    const desc = pluginHubText(p.description, lang)
    const done = doneUrls.includes(p.url) || hotUrls.includes(p.url)
    const already = isInstalled(p, catalogInstalled, repoIdentities, data?.plugins, repoHints)
    const busy = busyUrl === p.url
    const replacement = replacementOf(p)
    const verificationLabel = p.isVerified ? t('verificationPassed') : t('verificationUnverified')
    // The card reflects its own latest operation. Without this a rejected
    // install leaves the card looking untouched, and pressing Install again
    // is the obvious next move — which is how the same clash gets hit twice.
    const record = recordForUrl(records, p.url)
    const blocked = record !== null && (record.state === 'input' || record.state === 'failed')
    const action = done
      ? <span className={css.okState}><IconCheckOutline16 size={12} />{t('installedBadge')}</span>
      : already
        ? <span className={css.okState}><IconCheckOutline16 size={12} />{t('alreadyInstalled')}</span>
        : busy
          ? <Button variant="primary" size="sm" className={css.installBtn} disabled>{t('installing')}</Button>
          : p.installable === false
            ? (
                <Button
                  variant="primary"
                  size="sm"
                  className={css.installBtn}
                  disabled
                  title={p.validationReason ? `${verificationLabel}: ${p.validationReason}` : verificationLabel}
                >{t('install')}</Button>
              )
          : blocked
            ? (
                <button type="button" className={css.cardBlockedMark} onClick={openOperations}>
                  <IconWarningOutline16 size={13} />
                  {t('opBlockedCard')}
                </button>
              )
            : (
                <Button
                  variant="primary"
                  size="sm"
                  className={css.installBtn}
                  disabled={busyUrl !== null || !envReady}
                  onClick={() => setConfirming(p)}
                >{t('install')}</Button>
              )
    return (
      <div key={p.url} className={blocked ? `${css.card} ${css.cardBlocked}` : css.card}>
        <div className={css.main}>
          <div className={css.row1}>
            <div className={css.repoIdentity}>
              <a className={css.nmLink} href={p.url} target="_blank" rel="noreferrer" title={p.name} aria-label={`${p.name} — ${t('repoLink')}`}>
                {p.owner && (
                  <span className={css.ownerPrefix}>
                    <span className={css.ownerName} title={p.owner}>{p.owner}</span>/
                  </span>
                )}
                <span className={`${css.nm} ${css.pluginName}`} title={p.name}>{pluginName(p.name)}</span>
                <IconRightUpOutline14 className={css.repoMark} size={12} />
                {p.deprecated === true && <span className={css.depBadge}>{t('deprecatedBadge')}</span>}
              </a>
            </div>
            {typeof p.stars === 'number' && (
              <Tooltip label={String(p.stars)} side="top">
                <span className={css.cardStars} aria-label={`${p.stars} ${t('sortStars')}`}>
                  <Star size={12} strokeWidth={1.7} aria-hidden="true" />
                  {formatCount(p.stars)}
                </span>
              </Tooltip>
            )}
          </div>
          <CardDesc text={desc} t={t} />
          {p.deprecated === true && (
            <div className={css.deprecate}>
              <div className={css.depLine}>
                <IconWarningOutline16 size={14} />
                <span>{t('deprecatedWarn')}</span>
                {replacement !== undefined && (
                  <a className={css.src} href={replacement.url} target="_blank" rel="noreferrer">
                    {t('replacementHint') + ' ' + replacement.name}
                  </a>
                )}
              </div>
            </div>
          )}
          {busy && (
            <div className={css.progress}>
              <span className={css.spin}><IconLoadingOutline16 size={14} /></span>
              <code className={css.grow}>{progressText}</code>
              {progressPct !== null && <span className={css.pct}>{progressPct}%</span>}
              <Button variant="outline" size="sm" disabled={cancelling} onClick={doCancel}>
                {cancelling ? t('cancelling') : t('cancelOp')}
              </Button>
              <div className={css.bar}>
                <div
                  className={progressPct !== null ? css.barFill : `${css.barFill} ${css.barWave}`}
                  style={progressPct !== null ? { width: `${progressPct}%` } : undefined}
                />
              </div>
            </div>
          )}
        </div>
        <div className={css.foot}>
          <span className={css.verificationBadge} title={p.validationReason || t('verificationHelp')}>
            {verificationLabel}
          </span>
          {pluginCategories(p).map(category => (
            <span key={category} className={css.tag}>
              {pluginHubText(data!.categories[category], lang) || category}
            </span>
          ))}
          {/* Published date and a source link used to live here too — both
              redundant now that the title itself opens the repo, and the
              date/tag pair alone was long enough in English to wrap onto its
              own line, splitting one card's footer into two visual rows. */}
          <span className={css.grow} />
          {/* No comment count here. Showing one would mean asking giscus about
              every card on the page just to render a number, and a row of
              zeroes reads as "nobody uses these" on a catalog where almost
              nothing has been commented on yet. */}
          {COMMENTS_ENABLED && (
            <button type="button" className={css.commentsLink} onClick={() => setCommentsFor(p)}>
              {t('comments')}
            </button>
          )}
          <div className={css.cardAction}>{action}</div>
        </div>
      </div>
    )
  }

  const categories = data === null ? [] : Object.keys(data.categories).filter(id => id !== 'all')
  const discoverFilters = (
    <div className={css.discoverFilters}>
      <label className={css.verificationFilter} title={t('verificationHelp')}>
        <input type="checkbox" checked={verifiedOnly} onChange={e => setVerifiedOnly(e.target.checked)} />
        <span>{t('verifiedOnly')}</span>
      </label>
      <FilterMenu value={discoverSort} onChange={setDiscoverSort} sorts={data?.sorts} lang={lang} t={t} />
    </div>
  )

  /**
   * A fresh install (hotUrls/hotNames) and a toggle action
   * (refreshNames) both end in the same place — "reload the page" — and
   * used to render as two near-identical banners stacked on top of each
   * other when both happened in one session (reported as "为啥有三个状态横幅
   * 啊，太奇怪了"). They're merged into one count and one banner; only the
   * restart banner (a full host restart, a different action entirely) stays
   * separate.
   */
  const pendingRefreshNames = useMemo(
    () => [...new Set([...hotNames, ...refreshNames])],
    [hotNames, refreshNames],
  )

  return (
    <div
      className={css.root}
      data-dsh-pluginhub-root
      data-dsh-pluginhub-tab={tab}
    >
      <div className={css.head}>
        <div className={css.titleRow}>
          <h2 className={css.title}>{t('nav')}</h2>
          {version !== null && <span className={css.version} title={t('versionHint')}>v{version}</span>}
          <span className={css.grow} />
          {(() => {
            const self = PLUGINHUB_PACKAGE_NAME
            const status = updates[self]
            return status && status.updateAvailable && !updatedNames.includes(self)
              && !ignoredUpdateSet.has(self)
              && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={updatingName !== null || busyUrl !== null}
                  onClick={() => {
                    setTab('installed')
                    if (status.restoreRequired === true) askRestore(self)
                    else doUpdate(self)
                  }}
                >{updatingName === self ? t('updating') : status.restoreRequired === true ? t('restoreOnline') : t('pluginHubUpdate')}</Button>
              )
          })()}
          {reminderBatchUpdatableNames.length >= 2 && (
            <Button
              variant="primary"
              size="sm"
              disabled={updatingAll || updatingName !== null || busyUrl !== null || removingName !== null}
              onClick={() => { setTab('installed'); doUpdateAll() }}
            >{updatingAll ? t('updating') : t('updateAll') + ' (' + reminderBatchUpdatableNames.length + ')'}</Button>
          )}
          {bootId !== null && reminderUpdateNames.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => ignoreUpdateNotices(reminderUpdateNames)}
            >{t('ignoreAllUpdateNotices')}</Button>
          )}
          <a className={css.repoLink} href="https://github.com/funcodingdev/dsh-community-plugins" target="_blank" rel="noreferrer" title="dsh-community-plugins · GitHub">
            dsh-community-plugins <IconRightUpOutline14 size={12} />
          </a>
          <a className={css.submitLink} href="https://dshpluginhub.com/" target="_blank" rel="noreferrer">
            {t('submitPlugin')} <IconRightUpOutline14 size={12} />
          </a>
        </div>
        <p className={css.sub}>{t('subtitle')}</p>
        <div className={css.tabs}>
          <button className={tab === 'discover' ? `${css.tab} ${css.on}` : css.tab} onClick={() => setTab('discover')}>{t('tabDiscover')}</button>
          <button className={tab === 'installed' ? `${css.tab} ${css.on}` : css.tab} onClick={() => { setTab('installed'); refreshInstalled(true) }}>
            {t('tabInstalled') + (installedOtherCount > 0 ? ' (' + installedOtherCount + ')' : '')}
            {hasUpdates && <StateDot state="error" size={7} className={css.dot} />}
          </button>
          <span className={css.grow} />
          {/* In the tab row, not above the grid: paginating, searching and
              switching tab all leave it — and any pending decision — in place. */}
          <OperationsPanel
            t={t}
            describe={describePlugin}
            records={records}
            open={operationsOpen}
            onOpenChange={setOperationsOpen}
            replacing={replacing}
            envReady={envReady}
            onClearSettled={() => setRecords(list => clearSettled(list))}
            onCancel={() => doCancel()}
            onDismiss={record => setRecords(list => drop(list, record.id))}
            onRefresh={() => location.reload()}
            onResolveConflict={resolveConflict}
            onApproveBuilds={(record) => {
              const names = record.blockedBuilds ?? []
              if (names.length === 0) return
              setRecords(list => drop(list, record.id))
              const plugin = record.url === undefined ? undefined : data?.plugins.find(p => p.url === record.url)
              approveAndRetry(names, () => {
                if (plugin !== undefined) doInstall(plugin)
                else doUpdate(record.name, false, false)
              })
            }}
          />
        </div>
        {!envReady && (
          <div className={css.banner}>
            <IconCordisPluginOutline14 size={14} className={css.bannerIcon} />
            <span className={css.grow}>{envFailed ? t('envFixFail') : t('envMissing')}</span>
            {!envFailed && (
              <Button variant="primary" size="sm" disabled={envFixing} onClick={fixEnv}>
                {envFixing ? t('envFixing') : t('envFix')}
              </Button>
            )}
          </div>
        )}
        {pendingRefreshNames.length > 0 && (
          <div className={css.banner}>
            <IconSparkle16 size={14} className={css.bannerIcon} />
            <span className={css.grow}><b>{pendingRefreshNames.length}</b> {t('refreshBanner')}</span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (hotNames.length > 0) sessionStorage.setItem('dsph-toast', JSON.stringify(hotNames))
                sessionStorage.setItem('dsph-tab', 'installed')
                location.reload()
              }}
            >{t('refresh')}</Button>
          </div>
        )}
        {pendingRestart > 0 && (
          <div className={css.banner}>
            <IconRefreshOutline14 size={14} className={css.bannerIcon} />
            <span className={css.grow}><b>{pendingRestart}</b> {t('restartBanner')}</span>
            <Tooltip
              label={
                debuggerLatch !== null
                  ? t('restartHintDebugged')
                  : supervisor === null
                    ? t('restartHint')
                    : t('restartHintSupervised').replace('{0}', supervisor)
              }
              side="bottom"
            >
              <span className={css.bannerHint}><IconQuestionOutline14 size={14} /></span>
            </Tooltip>
            {restartEnabled && debuggerLatch === null && (
              <Button
                variant="primary"
                size="sm"
                disabled={restarting || hostBusy || busyUrl !== null || updatingName !== null || removingName !== null}
                onClick={doRestart}
              >{restarting ? t('restarting') : t('restartNow')}</Button>
            )}
            {/* Only the standing host-reported notice is dismissible: a
                banner for something you just did in this session should not
                be swipeable away mid-flow. */}
            {showHostPending && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('dismissNotice')}
                onClick={() => {
                  setRestartNoticeDismissed(true)
                  try { sessionStorage.setItem('dsph-restart-dismissed', String(bootId ?? '')) } catch { /* storage unavailable */ }
                }}
              >{t('dismiss')}</Button>
            )}
          </div>
        )}
        {activationWarnings.length > 0 && (
          <div className={css.banner}>
            <IconWarningOutline16 size={14} className={css.bannerIcon} />
            <span className={css.grow}>
              {activationWarnings.map(({ name, info }) => (
                <div key={name}>
                  <b>{name}</b> — {activationMeta(info.state, t).label}
                  {info.reasons.length > 0 && <span className={css.spec}>（{info.reasons.join(' / ')}）</span>}
                </div>
              ))}
            </span>
          </div>
        )}
        {tab === 'installed' && <HostDependencyDiagnostics findings={hostDependencyFindings} t={t} />}
      </div>
      {buildsSkipped !== null && (
        <div className={css.banner}>
          <IconWarningOutline16 size={14} className={css.bannerIcon} />
          <span className={css.grow}>{t('buildsSkipped')} {buildsSkipped.names.join(', ')}</span>
          <Button
            size="sm"
            disabled={busyUrl !== null}
            onClick={() => {
              const { plugin, updateName, names, restore } = buildsSkipped
              setBuildsSkipped(null)
              approveAndRetry(names, () => {
                if (plugin !== undefined) doInstall(plugin)
                else if (updateName !== undefined) doUpdate(updateName, false, restore === true)
              })
            }}
          >{t('approveBuilds')}</Button>
        </div>
      )}
      {compatibilityNotice !== null && (
        <div className={css.banner}>
          <span className={css.grow}>
            {/* Two independent findings share one banner and one rollback,
                because they came from one operation. Each is named for what
                it actually is: a peer-version risk and a loader-name
                collision are not the same problem and must not read as one. */}
            {compatibilityNotice.risks.length > 0 && (
              <><b>{t(compatibilityNotice.rollbackId === undefined ? 'compatRiskBannerNoRollback' : 'compatRiskBanner')}</b> {compatibilitySummary(compatibilityNotice.risks)}</>
            )}
            {compatibilityNotice.shadowedNames !== undefined && compatibilityNotice.shadowedNames.length > 0 && (
              <>
                {compatibilityNotice.risks.length > 0 && ' · '}
                <b>{t('shadowNameBanner')}</b> {shadowSummary(compatibilityNotice.shadowedNames)}
              </>
            )}
            {compatibilityNotice.brokenBundles !== undefined && compatibilityNotice.brokenBundles.length > 0 && (
              <>
                {(compatibilityNotice.risks.length > 0
                  || (compatibilityNotice.shadowedNames?.length ?? 0) > 0) && ' · '}
                <b>{t('brokenBundleBanner')}</b>{' '}
                {compatibilityNotice.brokenBundles.map(entry => entry.name).join(', ')}
              </>
            )}
          </span>
          {compatibilityNotice.rollbackId === undefined
            ? <span>{compatibilityNotice.rollbackUnavailable ?? t('rollbackUnavailable')}</span>
            : (
                <Button variant="primary" size="sm" disabled={rollingBack} onClick={() => void doRollback(compatibilityNotice.rollbackId!)}>
                  {rollingBack ? t('rollingBack') : t('rollbackNow')}
                </Button>
              )}
        </div>
      )}
      {installError !== null && (
        <div className={css.err}>
          {installError}
          {(staleName !== null || restoreName !== null) && <div className={css.staleAction}>
            {staleName !== null && (
              <Button size="sm" onClick={() => doUpdate(staleName, true)}>{t('updateNow')}</Button>
            )}
            {restoreName !== null && (
              <Button size="sm" onClick={() => doUpdate(restoreName, false, true)}>{t('restoreContinue')}</Button>
            )}
          </div>}
        </div>
      )}
      <div className={css.filtersHead}>
        {tab === 'discover'
          ? loadError !== null || data === null
            ? <div className={css.catsRow}>{discoverFilters}</div>
            : (
                <>
                  <div className={css.tabSearchRow}>
                    <Input className={css.tabSearch} icon={<IconSearchOutline16 size={14} />} placeholder={t('searchPh')} value={q} onChange={e => setQ(e.target.value)} />
                  </div>
                  <div className={css.cats}>
                    <div className={css.catsRow}>
                      {categories.length > 0 && (
                        <CategoryList value={cat} onChange={setCat} t={t} items={[
                          { id: 'all', label: (pluginHubText(data.categories.all, lang) || t('all')) + ' (' + formatCount(data.count) + ')' },
                          ...categories.map(id => ({ id, label: pluginHubText(data.categories[id], lang) || id })),
                        ]} />
                      )}
                      {discoverFilters}
                    </div>
                  </div>
                </>
              )
          : (
              <>
                <div className={css.tabSearchRow}>
                  <Input className={css.tabSearch} icon={<IconSearchOutline16 size={14} />} aria-label={t('searchPh')} placeholder={t('searchPh')} value={qInstalled} onChange={e => setQInstalled(e.target.value)} />
                </div>
                <div className={css.cats}>
                  <CategoryList value={installedCategory} onChange={setInstalledCategory} t={t} items={[
                    { id: 'all', label: t('all') + ' (' + formatCount(installedRows.length) + ')' },
                    ...installedCategoryIds.map(id => ({ id, label: installedCategoryLabel(id) + ' (' + formatCount(installedCategoryCounts.get(id) ?? 0) + ')' })),
                  ]} />
                </div>
              </>
            )}
      </div>
      <div
        className={css.body}
        ref={bodyRef}
        data-scrolling={scrolling}
        onScroll={e => {
          setShowTop(e.currentTarget.scrollTop > 400)
          setScrolling(true)
          if (scrollIdleTimer.current !== null) clearTimeout(scrollIdleTimer.current)
          scrollIdleTimer.current = setTimeout(() => setScrolling(false), 800)
        }}
      >
        {tab === 'discover'
          ? loadError !== null
            ? <div className={css.empty}>
                <div>{t('loadFail')}</div>
                <div className={css.err}>{loadError}</div>
                <Button variant="outline" size="sm" className={css.retryBtn} onClick={() => { void loadCatalog(1, true) }}>
                  {t('loadRetry')}
                </Button>
              </div>
              : data === null
              ? <div className={css.loading}><span className={css.spin}><IconLoadingOutline16 size={20} /></span>{t('loading')}</div>
              : (
                  <>
                    {plugins.length === 0
                      ? <div className={css.empty}>{t('empty')}</div>
                      : (
                          <>
                            <PluginGrid items={plugins} render={pluginCard} />
                            {hasMorePlugins && (
                              <div
                                ref={setLoadSentinel}
                                className={css.loadSentinel}
                                data-load-sentinel="true"
                                aria-hidden="true"
                              />
                            )}
                          </>
                        )}
                  </>
                )
          : (
                <>
                  {installedCatalogError && (
                    <div className={css.banner} role="status">
                      <span className={css.grow}>{t('installedCatalogFail')}</span>
                      <Button variant="outline" size="sm" onClick={() => setInstalledCatalogRetry(value => value + 1)}>{t('loadRetry')}</Button>
                    </div>
                  )}
                  {installedRows.length === 0
                    ? <div className={css.empty}>{t('installedEmpty')}</div>
                    : filteredInstalledRows.length === 0
                      ? <div className={css.empty} role="status">{t('empty')}</div>
                      : (
                          <PluginGrid
                            items={filteredInstalledRows}
                            render={({ name, spec, entry }) => {
                            const status = updates[name]
                            const localDev = /^(?:link|file):/i.test(String(spec)) || status?.kind === 'linked'
                            const act = activations[name]
                            const meta = act !== undefined ? activationMeta(act.state, t) : null
                            const version = status && status.version ? 'v' + status.version : ''
                            const specText = String(spec)
                            // A plain range beside the resolved version says the
                            // same thing twice. Every other spec — github:, file:,
                            // link:, a tag — is the only place the row says where
                            // the plugin came from, so it stays.
                            const specRedundant = version !== '' && /^[\^~]?\d/.test(specText)
                            const ghSpec = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#|$)/.exec(specText)
                            const repoUrl = entry !== undefined ? entry.url : ghSpec !== null ? 'https://github.com/' + ghSpec[1] : null
                            const off = effectiveDisabledSet.has(name)
                            // Switches only where they make sense: everything in
                            // the disable list (to re-enable), plus live/restart
                            // states. inert/broken rows keep their diagnosis
                            // without a misleading toggle (#60).
                            const toggleable = off || (act !== undefined && (act.state === 'live' || act.state === 'restart'))
                            return (
                              <div key={name} className={css.irow}>
                                <div style={{ minWidth: 0 }}>
                                  {/* Row-scoped, NOT `.nm` alone: `.nm` clips with
                                      overflow+ellipsis as one block, so with the name and
                                      the version as inline siblings the ellipsis landed at
                                      the end of the LINE and ate the version — a long
                                      scoped package name hid the one fact this row exists
                                      to state (#257 by @HualuozhE). Laying the row out as
                                      flex lets the name be the only thing that truncates.
                                      `.nm` is shared by six other places (discover titles,
                                      catalog cards); changing it there would
                                      reflow all of them. */}
                                  <div className={`${css.nm} ${css.irowName}`}>
                                    {/* The name is the link to the README. A separate button
                                        beside it pointed at the same page. */}
                                    <span className={css.irowNameText}>
                                      {repoUrl !== null
                                        ? <a className={css.nameLink} href={repoUrl + '#readme'} target="_blank" rel="noreferrer" title={name} aria-label={`${name} — ${t('readme')}`}>{name}</a>
                                        : name}
                                    </span>
                                    {entry?.deprecated === true && <span className={css.depBadge}>{t('deprecatedBadge')}</span>}
                                    {version && <span className={css.owner} title={version}>{version}</span>}
                                  </div>
                                  {specRedundant
                                    ? null
                                    : repoUrl !== null
                                      ? <a className={`${css.spec} ${css.src}`} href={repoUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block' }}>{specText}</a>
                                      : <div className={css.spec}>{specText}</div>}
                                  {/* The user's own note REPLACES the author's
                                      description (#347): a catalog blurb answers
                                      "what is this", written for strangers and
                                      often not in the reader's language, and
                                      cannot answer "why did I install this" —
                                      which is what someone with forty plugins
                                      is asking. The original stays one click
                                      away rather than being lost. */}
                                  {notingName === name
                                    ? (
                                        <div className={css.noteEdit}>
                                          <Input
                                            className={css.noteInput}
                                            value={noteDraft}
                                            maxLength={200}
                                            autoFocus
                                            placeholder={t('notePlaceholder')}
                                            onChange={e => setNoteDraft(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') saveNote(name, noteDraft)
                                              if (e.key === 'Escape') setNotingName(null)
                                            }}
                                          />
                                          <Button variant="outline" size="sm" onClick={() => saveNote(name, noteDraft)}>{t('noteSave')}</Button>
                                          <Button variant="ghost" size="sm" onClick={() => setNotingName(null)}>{t('cancel')}</Button>
                                        </div>
                                      )
                                    : (() => {
                                        const note = notes[name]
                                        const authored = pluginHubText(entry?.description, lang)
                                        const theirs = showTheirs.includes(name)
                                        const shown = note !== undefined && !theirs ? note : authored
                                        if (shown === '' && note === undefined) return null
                                        return (
                                          <div className={`${css.desc} ${css.descTight} ${css.noteRow}`}>
                                            <span className={note !== undefined && !theirs ? css.noteMine : undefined}>{shown}</span>
                                            {note !== undefined && authored !== '' && (
                                              <button
                                                type="button"
                                                className={css.noteToggle}
                                                title={theirs ? t('noteSeeMine') : t('noteSeeTheirs')}
                                                aria-label={theirs ? t('noteSeeMine') : t('noteSeeTheirs')}
                                                onClick={() => setShowTheirs(list => theirs ? list.filter(n => n !== name) : list.concat(name))}
                                              >{theirs ? t('noteMine') : t('noteTheirs')}</button>
                                            )}
                                            <button
                                              type="button"
                                              className={`${css.noteToggle} ${css.noteAction}`}
                                              title={note === undefined ? t('noteAdd') : t('noteEdit')}
                                              aria-label={note === undefined ? t('noteAdd') : t('noteEdit')}
                                              onClick={() => { setNoteDraft(note ?? ''); setNotingName(name) }}
                                            >{note === undefined ? t('noteAdd') : t('noteEdit')}</button>
                                          </div>
                                        )
                                      })()}
                                  {/* Update-notes entry (#294). Only a row with an
                                      update pending renders it — a plugin that is
                                      up to date has nothing to preview — and it is
                                      one quiet line in the flow the row already
                                      reserves for conditional content, so rows
                                      without it are pixel-identical to before. */}
                                  {status !== undefined && status.updateAvailable && (
                                    <div className={css.noteRow}>
                                      <button
                                        type="button"
                                        className={css.notesLink}
                                        onClick={() => openNotes(name, status.current ?? null, status.latest ?? null, repoUrl)}
                                      ><IconChevronRightOutline14 size={12} />{t('notesLink')}</button>
                                      {bootId !== null && (
                                        ignoredUpdateSet.has(name)
                                          ? <span className={css.metaInline}>{t('updateNoticeIgnored')}</span>
                                          : (
                                              <button
                                                type="button"
                                                className={css.noteToggle}
                                                aria-label={`${t('ignoreUpdateNotice')} ${name}`}
                                                onClick={() => ignoreUpdateNotices([name])}
                                              >{t('ignoreUpdateNotice')}</button>
                                            )
                                      )}
                                    </div>
                                  )}
                                  {!off && act !== undefined && meta !== null && (
                                        <div className={css.act}>
                                          {/* Only a state the switch does NOT already show earns a
                                              line here: "installed but not active" is news, "live"
                                              is what the switch is for. */}
                                          {meta.dot !== 'done' && (
                                            <span className={meta.dot === 'error' ? css.actBroken : css.actWarn}>
                                              <StateDot state={meta.dot} size={7} />
                                              {meta.label}
                                            </span>
                                          )}
                                          {act.state !== 'live' && act.reasons.length > 0 && (
                                            <DisclosureRow
                                              icon={<IconQuestionOutline14 size={14} />}
                                              title={t('actWhy')}
                                              open={whyOpen === name}
                                              expandable
                                              expandOnRowClick
                                              onToggle={() => setWhyOpen(whyOpen === name ? null : name)}
                                              className={css.actWhy}
                                            >
                                              <div className={css.spec}>{act.reasons.join(' / ')}</div>
                                            </DisclosureRow>
                                          )}
                                        </div>
                                      )}
                                  {entry !== undefined && entry.deprecated === true && (
                                    <div className={css.deprecate} style={{ marginTop: 8 }}>
                                      <div className={css.depLine}>
                                        <IconWarningOutline16 size={14} />
                                        <span>{t('deprecatedWarn')}</span>
                                        {entry.replacement !== undefined && (
                                          <span className={css.src}>{t('replacementHint') + ' ' + entry.replacement}</span>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                  {updatingName === name && (
                                    <div className={css.progress}>
                                      <span className={css.spin}><IconLoadingOutline16 size={14} /></span>
                                      <code className={css.grow}>{progressText}</code>
                                      {progressPct !== null && <span className={css.pct}>{progressPct}%</span>}
                                      <Button variant="outline" size="sm" disabled={cancelling} onClick={doCancel}>
                                        {cancelling ? t('cancelling') : t('cancelOp')}
                                      </Button>
                                      <div className={css.bar}>
                                        <div
                                          className={progressPct !== null ? css.barFill : `${css.barFill} ${css.barWave}`}
                                          style={progressPct !== null ? { width: `${progressPct}%` } : undefined}
                                        />
                                      </div>
                                    </div>
                                  )}
                                </div>
                                {/* At half width the identity and the controls cannot
                                    share a line, so the row is two stacked bands. Left
                                    as one wrapping line, neighbouring cards broke at
                                    different points and stopped lining up.
                                    The pluginhub itself never reaches this row (filtered
                                    out above — it manages itself from its own settings
                                    card), so no self-toggle special case is needed. */}
                                <div className={css.irowActions}>
                                {/* Dot + tag, the pairing the host's own plugin
                                    inventory uses for exactly this state. */}
                                <span className={css.stateTag} data-on={off ? 'false' : 'true'}>
                                  <span className={css.stateDot} data-on={off ? 'false' : 'true'} />
                                  {off ? t('disabledState') : t('switchOnLabel')}
                                </span>
                                {toggleable && (
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={!off}
                                    aria-label={(off ? t('enable') : t('disable')) + ' ' + name}
                                    className={off ? css.switch : `${css.switch} ${css.switchOn}`}
                                    disabled={togglingName !== null || busyUrl !== null || updatingName !== null || removingName !== null}
                                    onClick={() => doToggle(name, off)}
                                  >
                                    <span className={css.switchKnob} />
                                  </button>
                                )}
                                {/* State and switch pack left, the operations
                                    pack right: with everything in one flow the
                                    switch's x depended on whether the update
                                    slot rendered a button or a tag. */}
                                <span className={css.grow} />
                                {entry !== undefined && entry.deprecated === true && entry.replacement !== undefined && (() => {
                                  const replacement = data?.plugins.find(r => r.name === entry.replacement)
                                  if (replacement === undefined) return null
                                  return (
                                    <>
                                      <Button variant="outline" size="sm" onClick={() => { setCat('all'); setQ(entry.replacement!); setTab('discover') }}>{t('viewReplacement')}</Button>
                                      {!isInstalled(replacement, catalogInstalled, repoIdentities, data?.plugins, repoHints) && (
                                        <Button variant="outline" size="sm" onClick={() => setConfirming(replacement)}>{t('installReplacement')}</Button>
                                      )}
                                    </>
                                  )
                                })()}
                                {/* Status slot and Uninstall wrap as ONE unit. As
                                    sibling children of a wrapping flex row they broke
                                    apart independently, leaving the tag on one line and
                                    the button on the next (#242 by @Ztyss). Nested,
                                    the pair either fits or moves together, and the tag
                                    — already ellipsizing since #234 — is what gives up
                                    width first. */}
                                <span className={css.irowTrailing}>
                                {updatedNames.includes(name)
                                    ? <span className={`${css.metaTag} ${css.metaTagOk}`}>{act?.state === 'live' ? t('updatedLive') : t('updated')}</span>
                                    : updatingName === name
                                      ? <Button variant="primary" size="sm" className={css.warnBtn} disabled>{t('updating')}</Button>
                                      : status && status.updateAvailable
                                        ? (
                                            <Button
                                              variant="primary"
                                              size="sm"
                                              className={css.warnBtn}
                                              disabled={updatingName !== null}
                                              onClick={() => {
                                                if (status.restoreRequired === true) askRestore(name)
                                                else doUpdate(name)
                                              }}
                                            >{status.restoreRequired === true ? t('restoreOnline') : t('update')}</Button>
                                          )
                                        : localDev
                                          ? <span className={css.metaTag} title={t('linkedDev')}>{t('linkedDev')}</span>
                                          : <span className={css.metaTag} title={t('upToDate')}>{t('upToDate')}</span>}
                                {name !== PLUGINHUB_PACKAGE_NAME && (
                                  removingName === name
                                    ? <Button variant="outline" size="sm" className={css.dangerBtn} disabled>{t('uninstalling')}</Button>
                                    : (
                                        <>
                                          {localDev && status?.restoreRequired !== true && (
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={removingName !== null || busyUrl !== null || updatingName !== null}
                                              onClick={() => askRestore(name)}
                                            >{t('restore')}</Button>
                                          )}
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className={css.dangerBtn}
                                            disabled={removingName !== null || busyUrl !== null || updatingName !== null}
                                            onClick={() => setRemoveConfirm(name)}
                                          >{t('uninstall')}</Button>
                                        </>
                                      )
                                )}
                                </span>
                                </div>
                              </div>
                            )
                          }}
                          />
                        )}
                </>
              )}
      </div>
      {showTop && (
        <Tooltip label={t('backTop')} side="top">
          <span className={css.top}>
            <Button
              variant="outline"
              className={css.topBtn}
              aria-label={t('backTop')}
              onClick={() => { const el = bodyRef.current; if (el) el.scrollTo({ top: 0, behavior: 'smooth' }) }}
            ><IconChevronUpOutline14 size={16} /></Button>
          </span>
        </Tooltip>
      )}
      {confirming !== null && (
        <Modal
          open
          onClose={() => { setConfirming(null); setCmdOpen(false) }}
          title={t('confirmTitle') + ' ' + confirming.name + '?'}
          footer={(
            <>
              <Button variant="ghost" onClick={() => { setConfirming(null); setCmdOpen(false) }}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => doInstall(confirming)}>{t('confirmInstall')}</Button>
            </>
          )}
        >
          {/* The detail dialog has to show at LEAST what the card already
              does — owner, downloads, stars, published date, category — a
              "detail" view that shows less than the summary it opened from
              is backwards. */}
          <div className={css.byline}>
            <OwnerAvatar name={confirming.name} owner={confirming.owner || ''} />
            <span className={css.owner} title={confirming.owner}>{confirming.owner}</span>
            {typeof confirming.downloads === 'number' && (
              <Tooltip label={String(confirming.downloads)} side="top">
                <span className={css.star}><IconDownloadOutline16 size={12} />{formatCount(confirming.downloads)}</span>
              </Tooltip>
            )}
            {typeof confirming.stars === 'number' && (
              <Tooltip label={String(confirming.stars)} side="top">
                <span className={css.star} aria-label={`${confirming.stars} ${t('sortStars')}`}>
                  <Star size={12} strokeWidth={1.7} aria-hidden="true" />
                  {formatCount(confirming.stars)}
                </span>
              </Tooltip>
            )}
            <span className={css.grow} />
            {pluginCategories(confirming).map(category => (
              <span key={category} className={css.tag}>
                {pluginHubText(data!.categories[category], lang) || category}
              </span>
            ))}
          </div>
          {confirming.added && <div className={css.metaInline}>{t('published') + ' ' + confirming.added}</div>}
          {/* The Modal primitive's own `description` prop is sized for a
              one-line subtitle under the title — a full plugin description
              rendered there read as an oversized heading, not body text
              (reported on a real host). Rendering it here, at the card's own
              size, also matches the card's own reading order: name, byline,
              description, then screenshots. */}
          <CardDesc text={pluginHubText(confirming.description, lang)} t={t} />
          {(confirming.requiresBuildAuthorization || confirming.validationStatus === 'build_required') && (
            <p className={css.warnLine}>{t('verificationBuildHint')}</p>
          )}
          <ScreenshotStrip plugin={confirming} onOpen={openLightbox} />
          <DisclosureRow
            icon={<IconCodeOutline16 size={16} />}
            title={t('cmdDetails')}
            open={cmdOpen}
            expandable
            expandOnRowClick
            onToggle={() => setCmdOpen(o => !o)}
          >
            <div className={css.cmd}>{confirming.install}</div>
          </DisclosureRow>
          {looksTerminal(confirming, lang) && (
            <p className={css.warnLine}>
              <IconWarningOutline16 size={14} className={css.bannerIcon} />
              {' ' + t('terminalWarn') + ' '}
              <a className={css.src} href={confirming.url + '#readme'} target="_blank" rel="noreferrer">{t('readme')}</a>
            </p>
          )}
          {confirming.deprecated === true && (() => {
            const replacement = replacementOf(confirming)
            return (
              <div className={css.deprecate}>
                <div className={css.depLine}>
                  <IconWarningOutline16 size={14} />
                  <span>{t('deprecatedWarn')}</span>
                  {replacement !== undefined && (
                    <a className={css.src} href={replacement.url} target="_blank" rel="noreferrer">
                      {t('replacementHint') + ' ' + replacement.name}
                    </a>
                  )}
                </div>
              </div>
            )
          })()}
          <p className={css.modalNote}><IconWarningOutline16 size={14} className={css.bannerIcon} />{' ' + t('confirmWarn')}</p>
        </Modal>
      )}
      {COMMENTS_ENABLED && commentsFor !== null && (
        <CommentsModal
          key={commentsFor.url}
          name={pluginName(commentsFor.name)}
          url={commentsFor.url}
          lang={lang}
          onClose={() => setCommentsFor(null)}
          t={t}
        />
      )}
      {lightbox !== null && (
        <ScreenshotLightbox
          shots={lightbox.shots}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
          t={t}
        />
      )}
      {removeConfirm !== null && (
        <Modal
          open
          onClose={() => setRemoveConfirm(null)}
          title={t('uninstall') + ' ' + removeConfirm + '?'}
          description={t('uninstallConfirmDesc')}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setRemoveConfirm(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={removingName !== null} onClick={() => doUninstall(removeConfirm)}>{t('uninstall')}</Button>
            </>
          )}
        />
      )}
      {notesFor !== null && (
        <Modal
          open
          onClose={() => setNotesFor(null)}
          /* The host's Modal renders its title node verbatim; the hand-written
             primitives.d.ts narrows the prop to string, so this cast documents
             intent rather than defeating a runtime check. */
          title={(notesFor.repoUrl !== null
            ? <a className={css.nameLink} href={notesFor.repoUrl + '#readme'} target="_blank" rel="noreferrer">{notesFor.name}</a>
            : notesFor.name) as unknown as string}
          footer={(
            <Button variant="ghost" onClick={() => setNotesFor(null)}>{t('cancel')}</Button>
          )}
        >
          {/* The version line reads as versions when both ends are semver and
              as short shas when the plugin updates from git — a 40-char sha
              pair wraps the dialog into nonsense. */}
          {(notesFor.current !== null || notesFor.latest !== null) && (
            <div className={css.notesRange}>
              <span className={css.spec}>{notesFor.current !== null && notesFor.current.length === 40
                ? notesFor.current.slice(0, 7)
                : notesFor.current}</span>
              <span className={css.notesArrow}>→</span>
              <span className={css.spec}>{notesFor.latest !== null && notesFor.latest.length === 40
                ? notesFor.latest.slice(0, 7)
                : notesFor.latest}</span>
            </div>
          )}
          {notesState === 'loading' && <div className={css.spec}>{t('loading')}</div>}
          {notesState === 'fail' && <div className={css.spec}>{t('notesLoadFail')}</div>}
          {notesState === 'ready' && updateNotes !== null && (
            updateNotes.kind === 'release' ? (
              <div className={css.notesBody}>
                <div className={css.notesMeta}>
                  <strong>{t('notesRelease')}</strong>
                  {updateNotes.release.tag !== null && <span>{' ' + updateNotes.release.tag}</span>}
                  {updateNotes.release.publishedAt !== null && <span>{' · ' + updateNotes.release.publishedAt.slice(0, 10)}</span>}
                </div>
                {/* Author-written markdown, rendered through a deliberately
                    tiny converter: everything lands as React text children
                    (auto-escaped), so no HTML from the repo can ever become
                    markup — headings, bullets, bold and inline code only. */}
                <div className={css.notesRendered}>{renderMarkdown(updateNotes.release.body || t('notesNone'))}</div>
              </div>
            )
            : updateNotes.kind === 'commits' ? (
              <div className={css.notesBody}>
                <div className={css.notesMeta}><strong>{t('notesCommits')}</strong></div>
                {!updateNotes.commits.found && <div className={css.notesMeta}>{t('notesCommitsRecent')}</div>}
                <ul className={css.notesList}>
                  {updateNotes.commits.items.map(c => (
                    <li key={c.sha} className={css.notesRow}>
                      <span className={css.notesDate}>{c.date !== null ? c.date.slice(0, 10) : ''}</span>
                      <span className={css.notesMsg}>{mdInline(c.message)}</span>
                      {notesFor.repoUrl !== null && (
                        /* The commit itself on GitHub — the escape hatch when
                           two lines of clamp hide exactly the detail wanted. */
                        <a className={css.notesSha}
                          href={notesFor.repoUrl + '/commit/' + c.sha}
                          target="_blank" rel="noreferrer"
                          title={c.message}>{c.sha.slice(0, 7)}</a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
            : updateNotes.kind === 'npm' ? (
              <div className={css.notesBody}>
                <div className={css.notesMeta}><strong>{t('notesNpm')}</strong></div>
                <ul className={css.notesList}>
                  {updateNotes.npmTimes.map(v => (
                    <li key={v.version} className={css.notesRow}>
                      <span className={css.notesDate}>{v.date.slice(0, 10)}</span>
                      <a className={css.notesVer}
                        href={`https://www.npmjs.com/package/${encodeURIComponent(notesFor.name)}/v/${encodeURIComponent(v.version)}`}
                        target="_blank" rel="noreferrer">{v.version}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )
            : <div className={css.spec}>{t('notesNone')}</div>
          )}
        </Modal>
      )}
      {toggled !== null && (
        <Toast
          text={toggled.name + ' ' + t(toggled.enabled ? 'toastToggledOn' : 'toastToggledOff')}
          icon={toggled.enabled ? <IconCheckOutline16 size={14} /> : <IconWarningOutline16 size={14} />}
          onDone={toggledDone}
        />
      )}
    </div>
  )
}
