// @vitest-environment jsdom
/**
 * Layer-2 component specs (harness convention: jsdom pragma +
 * testing-library against the REAL component with the REAL locale dicts and
 * the REAL ui-primitives package). The host boundary is the four fetch
 * endpoints, stubbed with fixture payloads.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginHubSection, resetPluginHubPortalHost, resetPluginHubCache } from '../../src/client/PluginHubSection.tsx'
import { apply as applyPluginHub } from '../../src/client/index.ts'
import { pluginHubLanguage, resetScreenshotsCache } from '../../src/client/pluginhub-data.ts'
import { en, zh } from '../../src/client/locales.ts'

const REGISTRY = {
  updated: '', count: 4,
  categories: { tools: { en: 'Tools', zh: '工具' }, skill: { en: 'Skills', zh: '技能包' }, theme: { en: 'Themes', zh: '主题' } },
  plugins: [
    { name: 'dsh-loop', owner: 'alice', url: 'https://github.com/alice/dsh-loop', category: ['tools', 'skill'], npm: 'dsh-loop', stars: 50, added: '2026-08-01', description: { en: 'Loop task runner', zh: '循环执行' }, install: '' },
    { name: 'dsh-notify', owner: 'bob', url: 'https://github.com/bob/dsh-notify', category: 'tools', npm: null, stars: 120, added: '2026-08-10', description: { en: 'Desktop notifications', zh: '桌面通知' }, install: '' },
    { name: 'whale-skin', owner: 'carol', url: 'https://github.com/carol/whale-skin', category: 'theme', npm: null, stars: 80, added: '2026-08-14', description: { en: 'Whale theme', zh: '鲸鱼主题' }, install: '' },
  ],
}

const PLUGINHUB_API_URL = 'https://dshpluginhub.com/plugins.json'
const PLUGINHUB_CATEGORIES = {
  all: { en: 'All', zh: '全部' },
  interface: { en: 'Interface', zh: '界面扩展' },
  development: { en: 'Developer tools', zh: '开发工具' },
  automation: { en: 'Automation', zh: '自动化' },
  knowledge: { en: 'Knowledge & search', zh: '知识与检索' },
  agent: { en: 'Agent capability', zh: 'Agent 能力' },
}
const PLUGINHUB_SORTS = {
  recommended: { en: 'Recommended', zh: '推荐' },
  updated: { en: 'Recently updated', zh: '最近更新' },
  stars: { en: 'Most Stars', zh: '最多 Stars' },
}

function pluginHubPayload(value: unknown, requestUrl: string): unknown {
  if (value === null || typeof value !== 'object') return value
  if ('__status' in value) return value
  const wrapped = value as { registry?: unknown }
  const raw = wrapped.registry ?? value
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as any).plugins)) return value
  const registry = raw as any
  const url = new URL(requestUrl)
  const category = url.searchParams.get('category') ?? 'all'
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const sort = url.searchParams.get('sort') ?? 'recommended'
  const page = Number(url.searchParams.get('page') ?? 1)
  const pageSize = Number(url.searchParams.get('pageSize') ?? 12)
  const categories = { ...PLUGINHUB_CATEGORIES, ...(registry.categories ?? {}) }
  const sourcePlugins = registry.plugins.filter((plugin: any) => {
    if (url.searchParams.get('verifiedOnly') === 'true' && plugin.isVerified !== true) return false
    const ids = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
    if (category !== 'all' && !ids.includes(category)) return false
    if (query === '') return true
    const labels = ids.flatMap((id: string) => Object.values(categories[id] ?? {}))
    return [plugin.name, plugin.owner, ...Object.values(plugin.description ?? {}), ...labels]
      .some(value => String(value).toLowerCase().includes(query))
  })
  const sorted = [...sourcePlugins]
  if (sort === 'stars') sorted.sort((a, b) => Number(b.stars ?? 0) - Number(a.stars ?? 0))
  if (sort === 'updated') sorted.sort((a, b) => String(b.updatedAt ?? b.added ?? '').localeCompare(String(a.updatedAt ?? a.added ?? '')))
  sorted.sort((a, b) => Number(b.isVerified === true) - Number(a.isVerified === true))
  const start = (page - 1) * pageSize
  const plugins = sorted.slice(start, start + pageSize).map((plugin: any) => ({
    isVerified: true,
    installable: true,
    validationStatus: 'verified',
    requiresBuildAuthorization: false,
    ...plugin,
    category: Array.isArray(plugin.category) ? (plugin.category[0] ?? 'development') : plugin.category,
    description: {
      en: plugin.description?.en ?? plugin.description?.zh ?? '',
      zh: plugin.description?.zh ?? plugin.description?.en ?? '',
    },
  }))
  const totalPages = Math.ceil(sorted.length / pageSize)
  return {
    ...registry,
    name: 'dsh-plugin-hub',
    url: 'https://dshpluginhub.com',
    source: 'https://github.com/funcodingdev/dsh-plugin-hub',
    categories,
    sorts: PLUGINHUB_SORTS,
    plugins,
    pagination: {
      page,
      pageSize,
      total: sorted.length,
      totalPages,
      hasMore: page < totalPages,
      ...(page < totalPages ? { nextPage: page + 1 } : {}),
    },
  }
}

/** Every fetch the component made, for asserting request payloads. */
let fetchCalls: Array<{ path: string; method: string; body: unknown }> = []

function stubFetch(overrides: Record<string, unknown> = {}, mountPath = '') {
  fetchCalls = []
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    const requestUrl = String(input)
    const path = requestUrl.split('?')[0]
    const pluginhub = path === PLUGINHUB_API_URL
    const route = mountPath !== '' && path.startsWith(`${mountPath}/`)
      ? path.slice(mountPath.length)
      : path
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    fetchCalls.push({ path, method, body })
    const payload =
      pluginhub ? { source: 'live', registry: REGISTRY }
      : route === '/dsh-pluginhub/registry' ? { source: 'live', registry: REGISTRY }
      : route === '/dsh-pluginhub/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [] }
      : route === '/dsh-pluginhub/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
      : route === '/dsh-pluginhub/updates' ? { updates: {} }
      : route === '/dsh-pluginhub/toggle' ? { ok: true, disabled: [], live: [], activation: {} }
      : null
    const merged = overrides[requestUrl] ?? overrides[path] ?? overrides[route]
      ?? (pluginhub ? overrides['/dsh-pluginhub/registry'] : undefined) ?? payload
    if (merged === null) return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    const rawResult = typeof merged === 'function' ? (merged as (requestBody?: unknown) => unknown)(body) : merged
    const result = pluginhub ? pluginHubPayload(rawResult, requestUrl) : rawResult
    const status = result !== null && typeof result === 'object' && '__status' in result && typeof (result as { __status?: unknown }).__status === 'number'
      ? (result as { __status: number }).__status
      : 200
    return Promise.resolve(new Response(JSON.stringify(result), { status }))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

// Snapshot objects must be referentially stable — useSyncExternalStore
// treats a fresh object per call as an endless change feed.
const LOCALE_SNAPSHOT = { active: 'en' }

/** Escape a locale string so it can be used inside a RegExp literal. */
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

function props() {
  return {
    t: (key: string) => (en as Record<string, string>)[key] ?? key,
    locale: { subscribe: () => () => {}, getSnapshot: () => LOCALE_SNAPSHOT },
  }
}

function switchableLocaleProps(initial: string) {
  let snapshot = { active: initial }
  const listeners = new Set<() => void>()
  const locale = {
    subscribe(callback: () => void) {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    getSnapshot: () => snapshot,
  }
  const t = (key: string) => {
    const dictionary = pluginHubLanguage(snapshot.active) === 'zh' ? zh : en
    return (dictionary as Record<string, string>)[key] ?? key
  }
  return {
    props: { t, locale },
    setActive(active: string) {
      snapshot = { active }
      listeners.forEach(listener => { listener() })
    },
  }
}

beforeEach(() => { resetPluginHubCache(); stubFetch(); resetScreenshotsCache() })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('catalog memory cache', () => {
  it('reuses pages across section switches, expires them, and clears them on unload', async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const calls = () => fetchCalls.filter(call => call.path === PLUGINHUB_API_URL).length
    const locale = switchableLocaleProps('en')
    try {
      let view = render(<PluginHubSection {...locale.props} />)
      await screen.findByText('dsh-loop')
      expect(calls()).toBe(1)
      view.unmount()

      view = render(<PluginHubSection {...locale.props} />)
      await screen.findByText('dsh-loop')
      expect(calls()).toBe(1)
      view.unmount()

      now += 5 * 60_000
      view = render(<PluginHubSection {...locale.props} />)
      await screen.findByText('dsh-loop')
      expect(calls()).toBe(2)
      view.unmount()

      resetPluginHubCache()
      render(<PluginHubSection {...locale.props} />)
      await screen.findByText('dsh-loop')
      expect(calls()).toBe(3)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('pluginhub source link', () => {
  it.each([
    ['zh', '访问插件网站'],
    ['en', 'Visit plugin website'],
  ])('opens the website without changing the catalog API in %s', async (language, label) => {
    const locale = switchableLocaleProps(language)
    render(<PluginHubSection {...locale.props} />)

    const link = screen.getByRole('link', { name: label })
    expect(link.getAttribute('href')).toBe('https://dshpluginhub.com/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')

    await screen.findByText('dsh-loop')
    expect(fetchCalls).toContainEqual({ path: PLUGINHUB_API_URL, method: 'GET', body: undefined })
    expect(fetchCalls.some(call => call.path === 'https://dshpluginhub.com/')).toBe(false)
  })
})

describe('api() base resolution (#345)', () => {
  /** Behind a reverse proxy that mounts dsh under a prefix, a root-absolute
   * `/dsh-pluginhub/...` resolves against the ORIGIN and misses the prefix rule,
   * so the panel rendered and every request in it 404'd. Anchoring on the
   * document directory fixes that WITHOUT changing anything at the root,
   * which is where nearly everyone runs. */
  const base = () => document.querySelector('base')

  afterEach(() => { base()?.remove() })

  it('is unchanged at the root, which must not regress', async () => {
    const { api } = await import('../../src/client/pluginhub-data.ts')
    expect(api('/dsh-pluginhub/installed')).toBe('/dsh-pluginhub/installed')
  })

  it('follows the prefix the page is served under', async () => {
    const { api } = await import('../../src/client/pluginhub-data.ts')
    const tag = document.createElement('base')
    tag.setAttribute('href', 'http://host.example/app/my-dsh/')
    document.head.appendChild(tag)
    expect(api('/dsh-pluginhub/installed')).toBe('/app/my-dsh/dsh-pluginhub/installed')
    // Arbitrary depth, and a leading slash in the argument is not special.
    tag.setAttribute('href', 'http://host.example/user/a/b/')
    expect(api('dsh-pluginhub/status')).toBe('/user/a/b/dsh-pluginhub/status')
  })

  it('keeps newer changelog and note requests under that prefix too', async () => {
    const tag = document.createElement('base')
    tag.setAttribute('href', 'http://host.example/app/my-dsh/')
    document.head.appendChild(tag)
    const fetchMock = stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: ['dsh-loop'],
        disabled: [],
        notes: {},
      },
      '/dsh-pluginhub/updates': {
        updates: {
          'dsh-loop': {
            kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true,
          },
        },
      },
      '/dsh-pluginhub/changelog': {
        kind: 'release',
        release: {
          tag: 'v1.2.0', name: 'Subpath release', publishedAt: null, url: null, body: 'Subpath release notes',
        },
      },
      '/dsh-pluginhub/note': (body: any) => ({
        ok: true,
        notes: { [body.name]: String(body.text).trim() },
      }),
    }, '/app/my-dsh')

    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))

    fireEvent.click(await screen.findByRole('button', { name: en.noteAdd }))
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: 'for project A' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))
    expect(await screen.findByText('for project A')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.notesLink) }))
    expect(await screen.findByText('Subpath release notes')).toBeTruthy()

    expect(fetchCalls).toContainEqual({
      path: '/app/my-dsh/dsh-pluginhub/note',
      method: 'POST',
      body: { name: 'dsh-loop', text: 'for project A' },
    })
    expect(fetchCalls).toContainEqual({
      path: '/app/my-dsh/dsh-pluginhub/changelog',
      method: 'GET',
      body: undefined,
    })
    expect(fetchCalls.some(call => call.path === '/dsh-pluginhub/note')).toBe(false)
    expect(fetchCalls.some(call => call.path === '/dsh-pluginhub/changelog')).toBe(false)
    expect(fetchMock.mock.calls.some(([url]) =>
      url === '/app/my-dsh/dsh-pluginhub/changelog?name=dsh-loop')).toBe(true)
  })

  it('leaves no root-absolute endpoint anywhere in the client source', () => {
    // #345 has now been fixed twice. The first fix converted every endpoint
    // that existed; changelog and personal notes were written afterwards, as
    // ordinary-looking `fetch('/dsh-pluginhub/…')` calls, and escaped to the
    // origin root again (#407). Nothing about writing that line looks wrong,
    // and nothing fails until someone is behind a path-prefixed proxy — the
    // one population that cannot see this test, or fix it.
    //
    // So the invariant is checked over the SOURCE rather than per endpoint:
    // a per-call test can only cover calls somebody thought to add.
    const offenders: string[] = []
    for (const file of readdirSync(resolve('src/client'))) {
      if (!/\.tsx?$/.test(file)) continue
      const lines = readFileSync(resolve('src/client', file), 'utf8').split('\n')
      lines.forEach((line, index) => {
        // Prose about the bug is allowed to name the shape it describes; only
        // code counts. Comment lines in this codebase are `//`, `/*` or ` *`.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
        // The literal INSIDE an api() call is the correct shape — that is the
        // whole point of the helper — so remove those before looking at what
        // is left. What is left is a path the browser would resolve itself.
        const bare = code.replace(/\bapi\(\s*(['"`])\/?[^'"`]*\1\s*\)/g, 'api(…)')
        if (/['"`]\/dsh-pluginhub\//.test(bare)) offenders.push(`${file}:${index + 1}: ${code}`)
      })
    }
    expect(
      offenders,
      `route these through api() — a root-absolute path resolves against the origin, not the mount:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

describe('PluginHubSection (jsdom)', () => {
  const validationRegistry = {
    ...REGISTRY,
    count: 4,
    plugins: ['verified', 'build_required', 'pending', 'invalid'].map((status, i) => ({
      ...REGISTRY.plugins[0],
      name: `dsh-${status}`,
      url: `https://github.com/alice/dsh-${status}`,
      category: 'development',
      stars: i * 100,
      isVerified: i < 2,
      installable: i < 2,
      validationStatus: status,
      requiresBuildAuthorization: status === 'build_required',
    })),
  }

  it('shows only verified or unverified on cards while preserving install and build authorization behavior', async () => {
    stubFetch({ '/dsh-pluginhub/registry': validationRegistry })
    render(<PluginHubSection {...props()} />)
    for (const [status, label, disabled] of [
      ['verified', 'Verified', false], ['build_required', 'Verified', false],
      ['pending', 'Unverified', true], ['invalid', 'Unverified', true],
    ] as const) {
      const card = (await screen.findByText(`dsh-${status}`)).closest('[class*="card"]') as HTMLElement
      expect(within(card).getByText(label)).toBeTruthy()
      expect((within(card).getByRole('button', { name: en.install }) as HTMLButtonElement).disabled).toBe(disabled)
    }
    const buildCard = screen.getByText('dsh-build_required').closest('[class*="card"]') as HTMLElement
    fireEvent.click(within(buildCard).getByRole('button', { name: en.install }))
    expect(await screen.findByText('This plugin requires your authorization to run build scripts during installation.')).toBeTruthy()
  })

  it('sends the verification filter with existing search and sort, resets pagination and preserves server order', async () => {
    const fetchMock = stubFetch({ '/dsh-pluginhub/registry': validationRegistry })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-pending')
    const requests = () => fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'))
      .filter(url => url.origin + url.pathname === PLUGINHUB_API_URL)
    expect(requests()[0]!.searchParams.get('verifiedOnly')).toBe('false')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'dsh' } })
    await waitFor(() => expect(requests().at(-1)!.searchParams.get('q')).toBe('dsh'))
    fireEvent.click(screen.getByRole('button', { name: `${en.filter}: ${en.sortRecommended}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: PLUGINHUB_SORTS.stars.en }))
    await waitFor(() => expect(requests().at(-1)!.searchParams.get('sort')).toBe('stars'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Verified only' }))
    await waitFor(() => expect(screen.queryByText('dsh-pending')).toBeNull())
    await screen.findByText('dsh-build_required')
    expect(Object.fromEntries(requests().at(-1)!.searchParams)).toMatchObject({
      verifiedOnly: 'true', page: '1', q: 'dsh', sort: 'stars',
    })
    expect(screen.queryByText('dsh-invalid')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Verified only' }))
    await screen.findByText('dsh-invalid')
    const names = screen.getAllByRole('link', { name: new RegExp(`— ${en.repoLink}$`) }).map(link => link.getAttribute('title'))
    expect(names).toEqual(['dsh-build_required', 'dsh-verified', 'dsh-invalid', 'dsh-pending'])
  })

  it('keeps verification filtering usable after a 503 and displays a valid empty result', async () => {
    const fetchMock = stubFetch({ '/dsh-pluginhub/registry': { __status: 503, error: 'plugin_list_unavailable' } })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('HTTP 503')
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(pluginHubPayload({ ...REGISTRY, plugins: [] }, PLUGINHUB_API_URL))))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Verified only' }))
    expect(await screen.findByText(en.empty)).toBeTruthy()
    expect(screen.queryByText(en.loadFail)).toBeNull()
  })

  it.each([undefined, null, 'false'])('rejects an invalid required isVerified field: %s', async isVerified => {
    stubFetch({ '/dsh-pluginhub/registry': {
      ...validationRegistry, plugins: [{ ...validationRegistry.plugins[0], isVerified }],
    } })
    render(<PluginHubSection {...props()} />)
    expect(await screen.findByText('the pluginhub plugin 0 is invalid')).toBeTruthy()
  })

  it('discards an old second page when the verification filter starts a new query', async () => {
    let intersectTail: (() => void) | undefined
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe(target: HTMLElement) {
        if (target.dataset.loadSentinel === 'true') intersectTail = () => this.callback([{ isIntersecting: true }])
      }
      disconnect() {}
    })
    const registry = { ...validationRegistry, plugins: Array.from({ length: 13 }, (_, i) => ({
      ...validationRegistry.plugins[i === 12 ? 2 : 0], name: `dsh-page-${i}`, url: `https://github.com/alice/dsh-page-${i}`,
    })) }
    const fetchMock = stubFetch({ '/dsh-pluginhub/registry': registry })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-page-11')
    let resolvePage!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolvePage = resolve }))
    act(() => intersectTail!())
    const secondPageUrl = String(fetchMock.mock.calls.at(-1)![0])
    expect(new URL(secondPageUrl).searchParams.get('page')).toBe('2')
    const secondPageSignal = fetchMock.mock.calls.at(-1)![1]?.signal
    fireEvent.click(screen.getByRole('checkbox', { name: 'Verified only' }))
    await screen.findByText('dsh-page-11')
    expect(secondPageSignal?.aborted).toBe(true)
    expect(new URL(String(fetchMock.mock.calls.at(-1)![0])).searchParams.get('page')).toBe('1')
    await act(async () => resolvePage(new Response(JSON.stringify(pluginHubPayload(registry, secondPageUrl)))))
    expect(screen.queryByText('dsh-page-12')).toBeNull()
  })

  it('follows ctx.locale from the DSH plugin entry point for UI and pluginhub content', async () => {
    const hostLocale = switchableLocaleProps('zh')
    let section: ReactElement | undefined
    const ctx = {
      effect: (callback: () => unknown) => { callback() },
      locale: {
        ...hostLocale.props.locale,
        register: vi.fn(),
        bind: () => hostLocale.props.t,
      },
      slots: {
        inject: (slot: string, register: () => unknown) => {
          if (slot === 'settings.section') register()
        },
        register: (_meta: Record<string, unknown>, component: () => unknown) => {
          section = component() as ReactElement
          return () => {}
        },
      },
      inject: () => {},
    }
    applyPluginHub(ctx)
    if (section === undefined) throw new Error('the plugin did not register its settings section')
    render(section)

    expect(await screen.findByText('循环执行')).toBeTruthy()
    expect(screen.getByPlaceholderText(zh.searchPh)).toBeTruthy()
    expect(screen.getByRole('button', { name: /筛选: 推荐/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: zh.verifiedOnly })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(English|中文)$/ })).toBeNull()

    act(() => { hostLocale.setActive('en') })
    expect(await screen.findByText('Loop task runner')).toBeTruthy()
    expect(screen.getByPlaceholderText(en.searchPh)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Filter: Recommended/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: en.verifiedOnly })).toBeTruthy()
    expect(screen.queryByText('循环执行')).toBeNull()

    act(() => { hostLocale.setActive('fr') })
    expect(screen.getByText('Loop task runner')).toBeTruthy()
    expect(screen.getByPlaceholderText(en.searchPh)).toBeTruthy()
  })

  it('renders the catalog with install buttons once the registry loads', async () => {
    render(<PluginHubSection {...props()} />)
    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.getByText('dsh-notify')).toBeTruthy()
    // Theme entries carry an Install button too (discover tab shows all).
    expect(screen.getAllByRole('button', { name: en.install }).length).toBeGreaterThanOrEqual(3)
  })

  it('opens Discover with the host-provided plugin query', async () => {
    render(<PluginHubSection {...props()} preferredSubsectionId="discover:dsh-loop" />)

    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.tabDiscover }).className).toMatch(/\bon\b|_on_/)
    expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', 'dsh-loop')
    expect(screen.queryByText('dsh-notify')).toBeNull()
  })

  it('opens Installed with the host-provided plugin query', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' },
        live: ['dsh-loop', 'dsh-notify'],
        disabled: [],
        groups: {},
        groupOrder: [],
      },
    })

    render(<PluginHubSection {...props()} preferredSubsectionId="installed:dsh-loop" />)

    const installedTab = await screen.findByRole('button', { name: /Installed/ })
    expect(installedTab.className).toMatch(/\bon\b|_on_/)
    expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', 'dsh-loop')
    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.queryByText('dsh-notify')).toBeNull()
  })

  it('handles a later host navigation request without remounting', async () => {
    const { rerender } = render(
      <PluginHubSection {...props()} preferredSubsectionId="discover:dsh-loop" />,
    )
    expect(await screen.findByText('dsh-loop')).toBeTruthy()

    rerender(<PluginHubSection {...props()} preferredSubsectionId="discover:whale-skin" />)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', 'whale-skin')
    })
    expect(await screen.findByText('whale-skin')).toBeTruthy()
    expect(screen.queryByText('dsh-loop')).toBeNull()
  })

  it('handles the same destination again after the host clears the request', async () => {
    const { rerender } = render(
      <PluginHubSection {...props()} preferredSubsectionId="discover:dsh-loop" />,
    )
    const search = await screen.findByPlaceholderText(en.searchPh)
    expect(search).toHaveProperty('value', 'dsh-loop')

    rerender(<PluginHubSection {...props()} />)
    fireEvent.change(search, { target: { value: 'whale-skin' } })
    expect(search).toHaveProperty('value', 'whale-skin')

    rerender(<PluginHubSection {...props()} preferredSubsectionId="discover:dsh-loop" />)
    await waitFor(() => {
      expect(search).toHaveProperty('value', 'dsh-loop')
    })
  })

  it('ignores empty and unknown host destinations without resetting the current view', async () => {
    const { rerender } = render(<PluginHubSection {...props()} />)
    const search = await screen.findByPlaceholderText(en.searchPh)
    fireEvent.change(search, { target: { value: 'whale-skin' } })
    expect(search).toHaveProperty('value', 'whale-skin')

    rerender(<PluginHubSection {...props()} preferredSubsectionId="" />)
    expect(search).toHaveProperty('value', 'whale-skin')

    rerender(<PluginHubSection {...props()} preferredSubsectionId="future:plugin" />)
    expect(search).toHaveProperty('value', 'whale-skin')
  })

  /** #256 / #365: the title has always opened the repo, but `color:inherit`
   * with no underline meant nothing said so until the cursor was already on
   * it. The heading now carries the official external-link glyph and the link
   * names its destination. */
  it('gives every card title a visible, named link to its repository', async () => {
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    for (const plugin of REGISTRY.plugins) {
      const own = screen.getAllByLabelText(`${plugin.name} — ${en.repoLink}`)
      expect(own.length).toBeGreaterThan(0)
      for (const link of own) {
        expect(link.getAttribute('target')).toBe('_blank')
        expect(link.getAttribute('rel')).toBe('noreferrer')
        const card = link.closest('div[class*="card"]')
        const mark = card?.querySelector('[class*="repoMark"]')
        expect(mark).toBeTruthy()
        expect(mark?.getAttribute('viewBox')).toBe('0 0 8 14')
        expect(link.textContent).toContain(plugin.name)
        // The tooltip still carries the RAW catalog identity. For a compound
        // entry (owner#packages/x) the card shows only the short name, so
        // this attribute is the one place the full identity is readable —
        // 1.23.0 replaced it with the link wording and lost it.
        expect(link.getAttribute('title')).toBe(plugin.name)
        expect(link.getAttribute('href')).toBe(plugin.url)
      }
    }
  })

  it('scrolls the shared body back to the top when switching tabs', async () => {
    const { container } = render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    const scroller = container.querySelector('[data-dsh-pluginhub-root] > [class*="body"]') as HTMLElement
    expect(scroller).toBeTruthy()

    scroller.scrollTop = 800
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: en.backTop })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(scroller.scrollTop).toBe(0)
    expect(screen.queryByRole('button', { name: en.backTop })).toBeNull()

    scroller.scrollTop = 800
    fireEvent.click(screen.getByRole('button', { name: en.tabDiscover }))
    expect(scroller.scrollTop).toBe(0)

  })

  it('scrolls the shared body back to the top when switching Discover categories', async () => {
    const { container } = render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    const scroller = container.querySelector('[data-dsh-pluginhub-root] > [class*="body"]') as HTMLElement
    expect(scroller).toBeTruthy()

    scroller.scrollTop = 800
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: en.backTop })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(scroller.scrollTop).toBe(0)
    expect(screen.queryByRole('button', { name: en.backTop })).toBeNull()
    await waitFor(() => expect(screen.queryByText('whale-skin')).toBeNull())
  })

  it('marks only the repository-matched card for a same-named local link (#141)', async () => {
    const plugins = [
      { name: 'dsh-vision-bridge', owner: 'ximengxiaolan', url: 'https://github.com/ximengxiaolan/dsh-vision-bridge', category: 'tools', npm: null, description: { en: 'Other bridge' }, install: '' },
      { name: 'dsh-vision-bridge', owner: 'GXX182', url: 'https://github.com/GXX182/dsh-vision-bridge', category: 'tools', npm: null, description: { en: 'Local bridge' }, install: '' },
    ]
    stubFetch({
      '/dsh-pluginhub/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 2, categories: REGISTRY.categories, plugins },
      },
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-vision-bridge': 'link:D:/pro/dsh/dsh-vision-bridge' },
        repoIdentities: { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] },
        live: [],
      },
    })

    render(<PluginHubSection {...props()} />)
    const own = await screen.findByText('GXX182')
    const other = await screen.findByText('ximengxiaolan')
    const ownCard = own.closest('div[class*="card"]') as HTMLElement
    const otherCard = other.closest('div[class*="card"]') as HTMLElement
    expect(within(ownCard).getByText(en.alreadyInstalled)).toBeTruthy()
    expect(within(otherCard).getByRole('button', { name: en.install })).toBeTruthy()
    expect(within(otherCard).queryByText(en.alreadyInstalled)).toBeNull()
  })

  it('shows shared host dependency findings from the installed snapshot', async () => {
    const findings = Array.from({ length: 7 }, (_, index) => ({
      code: 'shared-host-package-dependency',
      severity: 'warning',
      subject: { kind: 'package', name: `plugin-${String(index + 1)}` },
      evidence: {
        basis: 'manifest-declaration',
        dependency: '@deepseek-ai/dsh-tools',
        declaredRange: `^0.${String(index + 1)}.0`,
        declaredIn: 'dependencies',
      },
    }))
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-excel-chat': '^0.33.0' },
        live: [],
        diagnostics: {
          schema: 'dsh-pluginhub/diagnostics/v1',
          findings: [
            ...findings,
            {
              code: 'shared-host-package-dependency',
              severity: 'error',
              subject: { kind: 'package', name: 'wrong-severity-plugin' },
              evidence: {
                basis: 'manifest-declaration',
                dependency: '@deepseek-ai/dsh-tools',
                declaredRange: '^0.0.1-rc.1',
                declaredIn: 'dependencies',
              },
            },
            {
              code: 'shared-host-package-dependency',
              severity: 'warning',
              subject: { kind: 'package', name: 'missing-basis-plugin' },
              evidence: {
                dependency: '@deepseek-ai/dsh-tools',
                declaredRange: '^0.0.1-rc.1',
                declaredIn: 'dependencies',
              },
            },
          ],
        },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    expect(screen.queryByText(en.hostDependencyWarning)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Installed/ }))
    expect(await screen.findByText(en.hostDependencyWarning)).toBeTruthy()
    expect(screen.getByText('plugin-1 → @deepseek-ai/dsh-tools@^0.1.0')).toBeTruthy()
    expect(screen.getByText('plugin-5 → @deepseek-ai/dsh-tools@^0.5.0')).toBeTruthy()
    expect(screen.queryByText(/plugin-6 →/)).toBeNull()
    expect(screen.queryByText(/plugin-7 →/)).toBeNull()
    expect(screen.getByText(en.hostDependencyMore.replace('{0}', '2'))).toBeTruthy()
    expect(screen.queryByText(/wrong-severity-plugin/)).toBeNull()
    expect(screen.queryByText(/missing-basis-plugin/)).toBeNull()
  })

  it('search narrows the grid to matching plugins', async () => {
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'notify' } })
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('dsh-notify')).toBeTruthy()
    })
  })

  it('renders the protocol category and searches through its localized label', async () => {
    const registry = {
      ...REGISTRY,
      categories: PLUGINHUB_CATEGORIES,
      plugins: REGISTRY.plugins.map((plugin, index) => ({
        ...plugin,
        category: index === 0 ? 'agent' : index === 2 ? 'interface' : 'development',
      })),
    }
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry } })
    render(<PluginHubSection {...props()} />)
    const name = await screen.findByText('dsh-loop')
    let card: HTMLElement | null = name
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    expect(within(card!).getByText('Agent capability')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'Agent capability' } })
    await waitFor(() => {
      expect(screen.getByText('dsh-loop')).toBeTruthy()
      expect(screen.queryByText('dsh-notify')).toBeNull()
    })
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agent capability' }))
    await waitFor(() => {
      expect(screen.getByText('dsh-loop')).toBeTruthy()
      expect(screen.queryByText('dsh-notify')).toBeNull()
    })
  })

  it('category pills filter and the sort menu matches the public directory', async () => {
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: 'Themes' }))
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('whale-skin')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /^All \(\d/ }))

    // Exactly the three modes from dsh-plugin-hub, with Recommended as the
    // default. Picking a mode closes the menu and updates the trigger label.
    fireEvent.click(screen.getByRole('button', { name: `${en.filter}: ${en.sortRecommended}` }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    expect(screen.getByRole('menuitem', { name: en.sortRecommended })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: en.sortRecentlyUpdated })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: en.sortMostStars })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: en.sortRecentlyUpdated }))
    await waitFor(() => {
      const names = screen.getAllByText(/^(dsh-loop|dsh-notify|whale-skin)$/).map(n => n.textContent)
      expect(names[0]).toBe('whale-skin') // newest first
      expect(screen.getByRole('button', { name: `${en.filter}: ${en.sortRecentlyUpdated}` })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: `${en.filter}: ${en.sortRecentlyUpdated}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortMostStars }))
    await waitFor(() => {
      const names = screen.getAllByText(/^(dsh-loop|dsh-notify|whale-skin)$/).map(n => n.textContent)
      expect(names[0]).toBe('dsh-notify') // most Stars first
    })
  })

  it('the install dialog opens with Confirm/Cancel and closes on cancel', async () => {
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    expect(await screen.findByRole('button', { name: en.confirmInstall })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirmInstall })).toBeNull())
  })

  it('shows curated registry screenshots in the dialog, and README-extracted ones as fallback (#61)', async () => {
    const CURATED = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/demo.png'
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].screenshots = [CURATED, 'https://evil.example/track.png']
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      if (path === PLUGINHUB_API_URL) return Promise.resolve(new Response(JSON.stringify(pluginHubPayload({ source: 'live', registry }, String(url))), { status: 200 }))
      if (path === '/dsh-pluginhub/installed') return Promise.resolve(new Response(JSON.stringify({ profile: 'web', installed: {}, live: [] }), { status: 200 }))
      if (path === '/dsh-pluginhub/status') return Promise.resolve(new Response(JSON.stringify({ active: false, pnpm: true, boot: 'boot-1', installed: {} }), { status: 200 }))
      if (path === '/dsh-pluginhub/updates') return Promise.resolve(new Response(JSON.stringify({ updates: {} }), { status: 200 }))
      // README fallback for dsh-notify (no curated screenshots).
      if (path === 'https://raw.githubusercontent.com/bob/dsh-notify/HEAD/README.md') {
        return Promise.resolve(new Response('# dsh-notify\n![shot](assets/notify.png)', { status: 200 }))
      }
      return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
    }))
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')

    // Grid order is by stars — walk up from the name to the card's own button.
    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }

    // Curated: the allowlisted screenshot renders, the third-party host never does.
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => {
      const srcs = [...document.querySelectorAll('img')].map(img => img.getAttribute('src'))
      // The strip proxies through images.weserv.nl for a resized render —
      // the ORIGINAL curated url is embedded as its `url` query param.
      expect(srcs.some(src => src?.includes(encodeURIComponent(CURATED.replace(/^https?:\/\//, ''))))).toBe(true)
      expect(srcs).not.toContain('https://evil.example/track.png')
      expect(srcs.some(src => src?.includes('evil.example'))).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirmInstall })).toBeNull())

    // Fallback: dsh-notify's dialog extracts from its README, path resolved to raw.
    fireEvent.click(installButtonOf('dsh-notify'))
    await screen.findByRole('button', { name: en.confirmInstall })
    await waitFor(() => {
      const srcs = [...document.querySelectorAll('img')].map(img => img.getAttribute('src'))
      const extracted = 'https://raw.githubusercontent.com/bob/dsh-notify/HEAD/assets/notify.png'
      expect(srcs.some(src => src?.includes(encodeURIComponent(extracted.replace(/^https?:\/\//, ''))))).toBe(true)
    })
  })

  it('keeps the Tasks entry wrapped so opening the panel does not shift the tab row', async () => {
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    const entry = await screen.findByRole('button', { name: new RegExp(`^${en.opTitle}$`) })
    const wrapBefore = entry.parentElement
    expect(wrapBefore?.className, 'idle Tasks entry must sit in .opWrap for stable tab-row spacing').toMatch(/opWrap/)
    fireEvent.click(entry)
    await screen.findByText(en.opEmpty)
    expect(entry.parentElement, 'opening the panel must not drop the .opWrap wrapper').toBe(wrapBefore)
    expect(entry.parentElement?.className).toMatch(/opWrap/)
  })

  it('shows a running update in the Tasks panel (#295)', async () => {
    // The panel answers "what is running right now", and an update is one of
    // the things that runs. `OperationKind` has carried 'update' since the
    // panel was written — only the enqueue was missing, so "update all" left
    // the panel empty while several plugins were mid-flight.
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-pluginhub/update': { ok: true, activation: {} },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    // The panel names the plugin being updated, not just "something running".
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en.opTitle) }))
    await waitFor(() => {
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain('dsh-loop')
    })
  })

  it('re-enables Restart now when a completed update leaves the last status poll busy (#440)', async () => {
    vi.useFakeTimers()
    try {
      let operationStarted = false
      let updateSettled = false
      let busyStatusObserved = false
      let resolveUpdate!: (response: Response) => void
      const updateResponse = new Promise<Response>((resolve) => { resolveUpdate = resolve })

      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        if (path === '/dsh-pluginhub/update') {
          operationStarted = true
          return updateResponse
        }
        const payload =
          path === PLUGINHUB_API_URL ? pluginHubPayload({ source: 'live', registry: REGISTRY }, String(url))
          : path === '/dsh-pluginhub/installed' ? {
              profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [],
            }
          : path === '/dsh-pluginhub/status' ? (() => {
              const busy = operationStarted && !updateSettled
              if (busy) busyStatusObserved = true
              return {
                active: busy, busy, pnpm: true, boot: 'boot-1', restart: true,
                installed: { 'dsh-loop': '^1.0.0' },
              }
            })()
          : path === '/dsh-pluginhub/updates' ? {
              updates: {
                'dsh-loop': {
                  kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true,
                },
              },
            }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))

      render(<PluginHubSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
      await vi.waitFor(() => { screen.getByRole('button', { name: en.update }) })
      fireEvent.click(screen.getByRole('button', { name: en.update }))

      // Observe the route-level mutation lock while the request is in flight.
      // The successful response then arrives before another status poll can
      // publish busy=false, which is the real ordering reported in #440.
      await vi.advanceTimersByTimeAsync(2100)
      expect(busyStatusObserved).toBe(true)
      updateSettled = true
      resolveUpdate(new Response(JSON.stringify({
        ok: true,
        activation: {
          'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] },
        },
      }), { status: 200 }))

      await vi.waitFor(() => {
        expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0)
      })
      expect((screen.getByRole('button', { name: en.restartNow }) as HTMLButtonElement).disabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stale update response arms the Update-now button (#22 flow)', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-pluginhub/update': { ok: false, stale: true, error: 'too fresh — wait or update now' },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const updateButton = await screen.findByRole('button', { name: en.update })
    fireEvent.click(updateButton)
    // The 502-stale path surfaces the plain-words error plus the one-time bypass.
    expect(await screen.findByRole('button', { name: en.updateNow })).toBeTruthy()
  })

  it('shows a failed update instead of leaving the row unchanged (#448)', async () => {
    // #448: the update failed (pnpm exit 1), the profile was rolled back,
    // log.ndjson recorded both — and the card said nothing, so the user
    // pressed update again. Whatever else happens, a failure has to be
    // visible on the surface the user is looking at.
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-pluginhub/update': { ok: false, error: 'ERR_PNPM_PREPARE_PACKAGE: the build script failed' },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    const banner = await screen.findByText(/ERR_PNPM_PREPARE_PACKAGE/)
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('dsh-loop')
  })

  it('a busy-agent update response names the running agent instead of the generic busy message', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-pluginhub/update': {
        ok: false,
        agentsBusy: true,
        runningAgents: ['main'],
        error: 'agents are running',
        __status: 409,
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const updateButton = await screen.findByRole('button', { name: en.update })
    fireEvent.click(updateButton)
    expect(await screen.findByText(`${en.agentBusyUpdate} (main)`)).toBeTruthy()
    expect(screen.queryByText(en.busyWait)).toBeNull()
  })

  it('shows a compatibility-risk banner after an update and rolls back on demand (#195)', async () => {
    const fetchMock = stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-pluginhub/update': {
        ok: true,
        activation: { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } },
        compatibility: {
          code: 'soft-incompatible',
          risks: [{ plugin: 'dsh-loop', peer: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7', resolved: '0.1.0-rc.6', direction: 'belowMin' }],
          rollbackId: 'rollback-1',
        },
      },
      '/dsh-pluginhub/rollback': { ok: true, rolledBack: true },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const updateButton = await screen.findByRole('button', { name: en.update })
    fireEvent.click(updateButton)
    expect(await screen.findByText(en.compatRiskBanner)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.rollbackNow }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-pluginhub/rollback')).toBe(true)
    })
    expect(screen.queryByText(en.compatRiskBanner)).toBeNull()
  })

  it('does not offer a rollback action when the server could not capture an exact source', async () => {
    const rollbackUnavailable = '更新前版本为 v1.0.0，但无法确认精确来源。 / The previous version was v1.0.0, but its exact source could not be verified.'
    const fetchMock = stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-pluginhub/update': {
        ok: true,
        activation: { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } },
        compatibility: {
          code: 'soft-incompatible',
          risks: [{ plugin: 'dsh-loop', peer: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7', resolved: '0.1.0-rc.6', direction: 'belowMin' }],
          rollbackUnavailable,
        },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    expect(await screen.findByText(en.compatRiskBannerNoRollback)).toBeTruthy()
    expect(screen.getByText(rollbackUnavailable)).toBeTruthy()
    expect(screen.queryByText(en.rollbackUnavailable)).toBeNull()
    expect(screen.queryByRole('button', { name: en.rollbackNow })).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-pluginhub/rollback')).toBe(false)
  })

  it('falls back to the generic rollback explanation for an older server', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-pluginhub/update': {
        ok: true,
        activation: { 'dsh-loop': { state: 'restart', hot: false, bundle: true, reasons: ['restart to apply'] } },
        compatibility: {
          code: 'soft-incompatible',
          risks: [{ plugin: 'dsh-loop', peer: '@deepseek-ai/dsh-settings', range: '^0.1.0-rc.7', resolved: '0.1.0-rc.6', direction: 'belowMin' }],
        },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.update }))

    expect(await screen.findByText(en.rollbackUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.rollbackNow })).toBeNull()
  })

  it('reveals the discover grid in 12-item batches as its sentinel enters view', async () => {
    let listObserverCallback: IntersectionObserverCallback | null = null
    class IntersectionObserverMock implements IntersectionObserver {
      readonly root = null
      readonly rootMargin = ''
      readonly thresholds = [0]
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
      }
      private readonly callback: IntersectionObserverCallback
      observe = (target: Element) => {
        if ((target as HTMLElement).dataset.loadSentinel === 'true') listObserverCallback = this.callback
      }
      unobserve = () => {}
      disconnect = () => {}
      takeRecords = () => []
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

    const plugins = Array.from({ length: 30 }, (_, i) => ({
      name: 'dsh-p' + (i + 1),
      owner: 'alice',
      url: 'https://github.com/alice/dsh-p' + (i + 1),
      category: 'tools',
      npm: null,
      stars: 30 - i,
      added: '2026-08-01',
      description: { en: 'Plugin ' + (i + 1) },
      install: '',
    }))
    stubFetch({
      '/dsh-pluginhub/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 30, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-p1')

    expect(screen.getByText('dsh-p12')).toBeTruthy()
    expect(screen.queryByText('dsh-p13')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Per page/ })).toBeNull()
    expect(listObserverCallback).not.toBeNull()

    const intersectTail = () => {
      const callback = listObserverCallback
      expect(callback).not.toBeNull()
      act(() => {
        callback!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        )
      })
    }

    intersectTail()
    await waitFor(() => {
      expect(screen.getByText('dsh-p24')).toBeTruthy()
      expect(screen.queryByText('dsh-p25')).toBeNull()
    })

    intersectTail()
    await waitFor(() => expect(screen.getByText('dsh-p30')).toBeTruthy())

    // Filtering or sorting is a new directory query: it returns to the first
    // 12 items and waits for the sentinel again, just like dsh-plugin-hub.
    fireEvent.click(screen.getByRole('button', { name: `${en.filter}: ${en.sortRecommended}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.sortRecentlyUpdated }))
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: en.install })).toHaveLength(12)
      expect(screen.queryByText('dsh-p13')).toBeNull()
    })
  })

  it('recommended preserves catalog order instead of applying a hidden legacy filter', async () => {
    const plugins = [
      { name: 'dsh-recommended', owner: 'a', url: 'https://github.com/a/dsh-recommended', category: 'tools', npm: null, stars: 1, added: '2026-01-01', description: { en: 'Recommended' }, install: '' },
      { name: 'dsh-popular', owner: 'b', url: 'https://github.com/b/dsh-popular', category: 'tools', npm: null, stars: 200, added: '2026-08-01', description: { en: 'Popular' }, install: '' },
    ]
    stubFetch({
      '/dsh-pluginhub/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 2, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-recommended')
    const names = screen.getAllByText(/^(dsh-recommended|dsh-popular)$/).map(node => node.textContent)
    expect(names).toEqual(['dsh-recommended', 'dsh-popular'])
  })
})

describe('stuck pending recovery (#32)', () => {
  it('a restored pending install that never landed resets to an error instead of "installing" forever', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an install whose response was lost.
      sessionStorage.setItem('dsph-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      render(<PluginHubSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.waitFor(() => { screen.getByRole('button', { name: `${en.opInstalling} 1/1` }) })
      fireEvent.click(screen.getByRole('button', { name: `${en.opInstalling} 1/1` }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel?.textContent).toContain('dsh-loop')
      // Host stays idle and the plugin never appears in installed: two polls
      // (2s apart) must conclude the install died and release the button.
      await vi.advanceTimersByTimeAsync(2100)
      await vi.advanceTimersByTimeAsync(2100)
      expect(sessionStorage.getItem('dsph-pending')).toBeNull()
      expect(screen.getByText(new RegExp(en.installFail))).toBeTruthy()
      expect(panel?.textContent).not.toContain('dsh-loop')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lost install progress (config page reopened)', () => {
  it('keeps the recovered install task aligned with the host lifecycle', async () => {
    vi.useFakeTimers()
    try {
      // Keep the original URL-only marker shape so updates from an older
      // client recover too; the catalog supplies the task's display name.
      sessionStorage.setItem('dsph-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      let settled = false
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        const payload =
          path === PLUGINHUB_API_URL ? pluginHubPayload({ source: 'live', registry: REGISTRY }, String(url))
          : path === '/dsh-pluginhub/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [] }
          : path === '/dsh-pluginhub/status' ? {
              active: !settled, busy: !settled, pnpm: true, boot: 'boot-1', restart: true,
              installed: settled ? { 'dsh-loop': '^1.0.0' } : {},
            }
          : path === '/dsh-pluginhub/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
      render(<PluginHubSection {...props()} />)
      await vi.waitFor(() => { screen.getByRole('button', { name: en.installing }) })
      fireEvent.click(screen.getByRole('button', { name: `${en.opInstalling} 1/1` }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain('dsh-loop')

      settled = true
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(sessionStorage.getItem('dsph-pending')).toBeNull()
        expect(panel!.textContent).not.toContain('dsh-loop')
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lost update progress (config page reopened)', () => {
  it('keeps the recovered update task aligned with the host lifecycle', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an update, then the config page closed
      // before the response arrived. The marker survives the unmount, so a
      // reopen restores the running row instead of losing its progress.
      sessionStorage.setItem('dsph-updating', JSON.stringify({ name: 'dsh-loop' }))
      let settled = false
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        const payload =
          path === PLUGINHUB_API_URL ? pluginHubPayload({ source: 'live', registry: REGISTRY }, String(url))
          : path === '/dsh-pluginhub/installed' ? { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [], disabled: [], groups: {}, groupOrder: [] }
          : path === '/dsh-pluginhub/status' ? {
              active: !settled, busy: !settled, pnpm: true, boot: 'boot-1', restart: true,
              installed: { 'dsh-loop': '^1.0.0' },
              phase: settled ? null : 'downloading', currentPackage: settled ? null : 'is-odd@3.0.1', done: settled ? 0 : 3,
            }
          : path === '/dsh-pluginhub/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
      render(<PluginHubSection {...props()} />)
      fireEvent.click(screen.getByRole('button', { name: new RegExp(re(en.tabInstalled)) }))
      // The restored marker re-renders the running row and its live progress.
      await vi.waitFor(() => { screen.getByRole('button', { name: en.updating }) })
      fireEvent.click(screen.getByRole('button', { name: re(en.opInstalling) }))
      const panel = document.querySelector('[class*="opPanel"]')
      expect(panel, 'the Tasks panel did not open').toBeTruthy()
      expect(panel!.textContent).toContain('dsh-loop')
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => { screen.getByText(/Downloading · is-odd@3\.0\.1 · 3 packages processed/) })
      // The host finishes the update; two idle polls hand the row back.
      settled = true
      await vi.advanceTimersByTimeAsync(2100)
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(sessionStorage.getItem('dsph-updating')).toBeNull()
        expect(screen.queryByRole('button', { name: en.updating })).toBeNull()
        expect(panel!.textContent).not.toContain('dsh-loop')
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P1-6 structured progress', () => {
  it('shows the pnpm phase + package + count, and a disabled cancel button while cancelling', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an install whose response was lost.
      sessionStorage.setItem('dsph-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      stubFetch({
        '/dsh-pluginhub/status': {
          active: true, phase: 'downloading', done: 3, currentPackage: 'is-odd@3.0.1',
          size: 1000, downloaded: 400, cancelling: true, installed: {},
          pnpm: true, boot: 'boot-1', restart: true,
        },
      })
      render(<PluginHubSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(screen.getByText(/Downloading · is-odd@3\.0\.1 · 3 packages processed/)).toBeTruthy()
      })
      const cancel = screen.getByRole('button', { name: en.cancelling })
      expect((cancel as HTMLButtonElement).disabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P0-2 activation states in the Installed tab', () => {
  it('chips only the states the switch does not already show', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' },
        live: ['whale-skin'],
        activation: {
          'dsh-loop': { state: 'restart', reasons: ['in the bundle layer but not hot-mounted — it activates on restart'], bundle: true, hot: false },
          'whale-skin': { state: 'live', reasons: ['live via its bundle patch'], bundle: true, hot: true },
        },
      },
      '/dsh-pluginhub/updates': { updates: {} },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText(en.stateRestart)
    // "Installed but not active yet" is news and keeps its chip. "Active" is
    // exactly what the switch beside it means, so a chip repeating it made the
    // row state one fact twice and left the reader pairing them up.
    expect(screen.queryByText(en.stateLive)).toBeNull()
    expect(screen.getAllByText(en.switchOnLabel).length).toBeGreaterThan(0)
    // The reason is behind a disclosure; the chip itself must not claim success.
    expect(screen.getByText(en.stateRestart).textContent).toContain(en.stateRestart)
  })
})

describe('the installed row states a version once', () => {
  it('drops a plain range beside the resolved version, keeps a source spec', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'dsh-notify': 'github:bob/dsh-notify' },
        live: ['dsh-loop', 'dsh-notify'],
        activation: {
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
          'dsh-notify': { state: 'live', reasons: [], bundle: true, hot: true },
        },
      },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { version: '1.0.0', kind: 'npm', updateAvailable: false } } },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText(re('v1.0.0'))

    // "^1.0.0" under "v1.0.0" is the same fact twice.
    expect(screen.queryByText('^1.0.0')).toBeNull()
    // A github: spec is the only place the row says where it came from.
    expect(screen.getByText('github:bob/dsh-notify')).toBeTruthy()
  })
})

describe('#60 enable/disable switches in the Installed tab', () => {
  function installedStub(overrides: Record<string, unknown>): void {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: [],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
        },
        ...overrides,
      },
    })
  }

  it('renders an on switch for a live plugin and posts the disable toggle', async () => {
    installedStub({})
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-pluginhub/toggle')
      expect(toggle?.body).toEqual({ name: 'dsh-loop', enabled: false })
    })
  })

  /** #299: the switch and the row tag both say the new state, but they sit in
   * a row the user may have scrolled past, so a mis-click went unnoticed for
   * half a day. The toast is fixed on screen — that is the part that catches
   * it — and it carries the consequence, not just the new state. */
  it('toasts the plugin name and what a disable actually did', async () => {
    installedStub({})
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('switch', { name: en.disable + ' dsh-loop' }))
    expect(await screen.findByText('dsh-loop ' + en.toastToggledOff)).toBeTruthy()
  })

  it('toasts a re-enable without the stopped-working wording', async () => {
    installedStub({ live: [], disabled: ['dsh-loop'] })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('switch', { name: en.enable + ' dsh-loop' }))
    expect(await screen.findByText('dsh-loop ' + en.toastToggledOn)).toBeTruthy()
    expect(screen.queryByText('dsh-loop ' + en.toastToggledOff)).toBeNull()
  })

  it('shows the disabled state with an off switch and hides the restart label', async () => {
    installedStub({
      live: [],
      disabled: ['dsh-loop'],
      activation: {
        'dsh-loop': { state: 'restart', reasons: ['in the bundle layer but not hot-mounted'], bundle: true, hot: false },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.disabledState)).toBeTruthy()
    const sw = screen.getByRole('switch', { name: en.enable + ' dsh-loop' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    // The disabled chip replaces the misleading "restart to apply" label.
    expect(screen.queryByText(en.stateRestart)).toBeNull()
  })

  it('omits switches for inert and broken plugins', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' },
        live: [],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          'dsh-loop': { state: 'inert', reasons: ['no dsh.bundle'], bundle: false, hot: false },
          'whale-skin': { state: 'broken', reasons: ['no dsh metadata'], bundle: false, hot: false },
        },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.stateInert)).toBeTruthy()
    expect(screen.getByText(en.stateBroken)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('never lists the pluginhub itself in the Installed tab — it manages itself from its own settings card', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-community-plugins': '^1.5.0', 'dsh-loop': '^1.0.0' },
        live: ['dsh-community-plugins', 'dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          'dsh-community-plugins': { state: 'live', reasons: [], bundle: true, hot: true },
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
        },
      },
    })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    // A real plugin is installed alongside the pluginhub — its row shows,
    // proving the list isn't just empty, but the pluginhub's own row does not.
    await screen.findByText('dsh-loop')
    // The repository link remains in the header, but the pluginhub package
    // must not appear as an installed-plugin row.
    expect(screen.getAllByText('dsh-community-plugins')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'dsh-community-plugins' }).getAttribute('href'))
      .toBe('https://github.com/funcodingdev/dsh-community-plugins')
    // The tab's own count badge counts the one real plugin, not the pluginhub too.
    expect(screen.getByRole('button', { name: /^Installed \(1\)/ })).toBeTruthy()
  })

  it('shows the Installed empty state when the pluginhub is the only thing "installed"', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-community-plugins': '^1.5.0' },
        live: ['dsh-community-plugins'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-community-plugins': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.installedEmpty)).toBeTruthy()
    expect(screen.getAllByText('dsh-community-plugins')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Installed \(\d/ })).toBeNull()
  })

  it('shows the pending-restart banner when a toggle needs a boot to apply', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: ['dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
      '/dsh-pluginhub/toggle': () => ({
        ok: true,
        name: 'dsh-loop',
        enabled: false,
        disabled: ['dsh-loop'],
        live: [],
        restart: true,
        activation: { 'dsh-loop': { state: 'disabled', reasons: ['disabled'], bundle: true, hot: false } },
      }),
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    fireEvent.click(sw)
    await waitFor(() => {
      expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0)
    })
    // The toggle joins the persisted pending-restart set under the boot.
    await waitFor(() => {
      expect(sessionStorage.getItem('dsph-restart')).toContain('"toggled":1')
    })
  })

  it('shows the refresh banner when a client-part toggle needs a reload', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: ['dsh-loop'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
      '/dsh-pluginhub/toggle': () => ({
        ok: true,
        name: 'dsh-loop',
        enabled: false,
        disabled: ['dsh-loop'],
        live: [],
        restart: false,
        refresh: true,
        activation: { 'dsh-loop': { state: 'disabled', reasons: ['disabled'], bundle: true, hot: false } },
      }),
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    fireEvent.click(sw)
    await waitFor(() => {
      expect(screen.getAllByText(re(en.refreshBanner)).length).toBeGreaterThan(0)
    })
    // No restart banner — the toggle itself went live.
    expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
  })

  it('merges a hot install and a toggle-refresh into ONE banner instead of stacking two ("三个状态横幅")', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-notify': '^1.0.0' },
        live: ['dsh-notify'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-notify': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
      '/dsh-pluginhub/install': () => ({
        ok: true,
        hot: true,
        installed: { 'dsh-notify': '^1.0.0', 'dsh-loop': '^1.0.0' },
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-pluginhub/toggle': () => ({
        ok: true,
        name: 'dsh-notify',
        enabled: false,
        disabled: ['dsh-notify'],
        live: [],
        restart: false,
        refresh: true,
        activation: { 'dsh-notify': { state: 'disabled', reasons: ['disabled'], bundle: true, hot: false } },
      }),
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')

    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })
    fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-notify' })
    fireEvent.click(sw)

    await waitFor(() => {
      // Both changes pending a reload, but ONE banner — the count reflects
      // both plugins, not two separate near-identical strips stacked up.
      const banners = screen.getAllByText(re(en.refreshBanner))
      expect(banners.length).toBe(1)
      expect(banners[0]!.textContent).toContain('2')
    })
  })
})

/** #340: the banner counts what the page has not caught up with, and both
 * of its sets were append-only — nothing anywhere removed a name. Install
 * then uninstall and the page is level again, with nothing left for a
 * refresh to show, yet it kept asking. It was reporting session history,
 * not pending work. */
describe('refresh banner falls back when the change is undone (#340)', () => {
  it('stops asking after the installed plugin is uninstalled again', async () => {
    let present: Record<string, string> = {}
    stubFetch({
      '/dsh-pluginhub/installed': () => ({
        profile: 'web', installed: present, live: Object.keys(present), disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-pluginhub/install': () => {
        present = { 'dsh-loop': '^1.0.0' }
        return { ok: true, hot: true, installed: present }
      },
      '/dsh-pluginhub/uninstall': () => { present = {}; return { ok: true, hot: true } },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    // The card for THIS plugin, not whichever Install button sorts first —
    // installing one plugin and uninstalling another would prove nothing.
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    // The modal's confirm carries the same label as the row's trigger, so it
    // is the LAST one on screen once the dialog is open.
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.queryAllByText(re(en.refreshBanner))).toHaveLength(0))
  })

  it('still stops asking when the undone plugin has a client part', async () => {
    // Same shape as the test above, except the route now answers
    // `refresh: true` because the package declares dsh.client. Installing and
    // uninstalling inside one page still nets to zero: the client bundle was
    // never injected, so the banner was asking the user to reload IN ORDER TO
    // get it, and after the uninstall there is nothing to reload for.
    let present: Record<string, string> = {}
    stubFetch({
      '/dsh-pluginhub/installed': () => ({
        profile: 'web', installed: present, live: Object.keys(present), disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-pluginhub/install': () => {
        present = { 'dsh-loop': '^1.0.0' }
        return { ok: true, hot: true, installed: present }
      },
      '/dsh-pluginhub/uninstall': () => { present = {}; return { ok: true, hot: true, refresh: true } },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    fireEvent.click(within(card!).getAllByRole('button', { name: en.install })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.queryAllByText(re(en.refreshBanner))).toHaveLength(0))
  })

  it('asks for a reload when a plugin the page had loaded is uninstalled (#415)', async () => {
    // Installed BEFORE this page loaded, so its client bundle is injected and
    // still on screen after the package is gone. Exactly one banner, and it
    // is the refresh one: a hot uninstall needs no host restart.
    stubFetch({
      '/dsh-pluginhub/installed': () => ({
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-pluginhub/uninstall': () => ({ ok: true, hot: true, refresh: true }),
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))
    // Not two. A restart banner here would be the "为啥有三个状态横幅啊" shape.
    expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
  })

  it('leaves a non-hot uninstall with only its restart banner (#415)', async () => {
    // The other arm: a removal that needs a host restart already tells the
    // user to restart, and a restart reloads the page. Adding a reload banner
    // beside it asks twice for one action.
    stubFetch({
      '/dsh-pluginhub/installed': () => ({
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [],
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: false } },
      }),
      '/dsh-pluginhub/uninstall': () => ({ ok: true, hot: false }),
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.uninstall }))[0]!)
    await screen.findByText(re(en.uninstallConfirmDesc))
    fireEvent.click(screen.getAllByRole('button', { name: en.uninstall }).at(-1)!)

    await waitFor(() => expect(screen.getAllByText(re(en.restartBanner)).length).toBe(1))
    expect(screen.queryAllByText(re(en.refreshBanner)).length).toBe(0)
  })

  it('stops asking when a switch is put back where the page found it', async () => {
    let disabled: string[] = []
    stubFetch({
      '/dsh-pluginhub/installed': () => ({
        profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled,
        activation: { 'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true } },
      }),
      '/dsh-pluginhub/toggle': (body: any) => {
        disabled = body.enabled ? [] : ['dsh-loop']
        return { ok: true, disabled, live: body.enabled ? ['dsh-loop'] : [], refresh: true }
      },
    })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))

    fireEvent.click(await screen.findByRole('switch', { name: en.disable + ' dsh-loop' }))
    await waitFor(() => expect(screen.getAllByText(re(en.refreshBanner)).length).toBe(1))

    // Back to the position the page was rendered with: nothing to show.
    fireEvent.click(await screen.findByRole('switch', { name: en.enable + ' dsh-loop' }))
    await waitFor(() => expect(screen.queryAllByText(re(en.refreshBanner))).toHaveLength(0))
  })
})

/** #342 / #343: a scoped package name is what tells two installed plugins
 * apart, and the ellipsis removed exactly the end that distinguishes them —
 * `@deepseek-ai/dsh-client-ui-…` next to `@dsh-external/dsh-sessi…` are both
 * just prefixes. */
describe('long installed names stay readable (#342, #343)', () => {
  const LONG = '@deepseek-ai/dsh-client-ui-settings-plugins-extended'

  it('does not truncate, and names itself on hover either way', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web', installed: { [LONG]: '^1.0.0' }, live: [LONG], disabled: [],
      },
    })
    const { container } = render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText(LONG)

    const cell = container.querySelector('[class*="irowNameText"]')!
    expect(cell.textContent).toBe(LONG)
    const link = cell.querySelector('a')
    if (link !== null) expect(link.getAttribute('title')).toBe(LONG)
  })
})

/** #347: a catalog description answers "what is this", written by its author
 * for strangers and often not in the reader's language. It cannot answer "why
 * did I install this", which is what someone with forty plugins is asking. */
describe('plugin notes (#347)', () => {
  const installedStub = (notes: Record<string, string> = {}) => stubFetch({
    '/dsh-pluginhub/installed': () => ({
      profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: ['dsh-loop'], disabled: [], notes,
    }),
    '/dsh-pluginhub/note': (body: any) => ({
      ok: true,
      // Mirrors the route: trimmed, and empty clears rather than storing blank.
      notes: String(body.text).trim() === '' ? {} : { [body.name]: String(body.text).trim() },
    }),
  })

  it('shows the author description until a note replaces it', async () => {
    installedStub()
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    expect(await screen.findByText('Loop task runner')).toBeTruthy()

    const addNote = screen.getByRole('button', { name: en.noteAdd })
    // #399: this must read as an action, not as a third piece of the author
    // description. The original/mine toggle deliberately remains quiet text.
    expect(addNote.className).toMatch(/noteAction/)
    fireEvent.click(addNote)
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: 'for project A' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))

    // The note takes the description's place rather than sitting beside it.
    expect((await screen.findByText('for project A')).className).toMatch(/noteMine/)
    expect(screen.getByRole('button', { name: en.noteEdit }).className).toMatch(/noteAction/)
    await waitFor(() => expect(screen.queryByText('Loop task runner')).toBeNull())
  })

  it('keeps the original one click away, and puts it back', async () => {
    installedStub({ 'dsh-loop': 'for project A' })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText('for project A')

    fireEvent.click(screen.getByRole('button', { name: en.noteSeeTheirs }))
    expect(await screen.findByText('Loop task runner')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.noteSeeMine }))
    expect(await screen.findByText('for project A')).toBeTruthy()
  })

  it('clearing a note restores the author description', async () => {
    installedStub({ 'dsh-loop': 'for project A' })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    await screen.findByText('for project A')

    fireEvent.click(screen.getByRole('button', { name: en.noteEdit }))
    fireEvent.change(screen.getByPlaceholderText(en.notePlaceholder), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: en.noteSave }))

    expect(await screen.findByText('Loop task runner')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.noteSeeTheirs })).toBeNull()
  })
})

describe('#60 catalog deprecation', () => {
  const DEPRECATED_REGISTRY = {
    updated: '', count: 3,
    categories: { tools: { en: 'Tools', zh: '工具' } },
    plugins: [
      { name: 'dsh-old', owner: 'alice', url: 'https://github.com/alice/dsh-old', category: 'tools', npm: 'dsh-old', stars: 5, added: '2026-01-01', description: { en: 'Legacy runner', zh: '旧插件' }, install: '', deprecated: true, replacement: 'dsh-new' },
      { name: 'dsh-new', owner: 'bob', url: 'https://github.com/bob/dsh-new', category: 'tools', npm: 'dsh-new', stars: 20, added: '2026-08-01', description: { en: 'Modern runner', zh: '新插件' }, install: '' },
      { name: 'dsh-plain', owner: 'carol', url: 'https://github.com/carol/dsh-plain', category: 'tools', npm: null, stars: 3, added: '2026-07-01', description: { en: 'Plain plugin', zh: '普通插件' }, install: '' },
    ],
  }
  const contains = (text: string) => (content: string) => content.includes(text)

  it('shows the deprecated badge on the discover card and warns in the install dialog', async () => {
    stubFetch({ '/dsh-pluginhub/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY } })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-old')
    expect(screen.getByText(en.deprecatedBadge)).toBeTruthy()
    expect(screen.getByText(contains(en.deprecatedWarn))).toBeTruthy()
    // Open dsh-old's own install dialog: it carries the deprecation warning
    // plus the replacement name/link.
    const oldCard = screen.getByText('dsh-old').closest('[class*="card"]') as HTMLElement
    fireEvent.click(within(oldCard).getByRole('button', { name: en.install }))
    expect(await screen.findByText('Install dsh-old?')).toBeTruthy()
    expect(screen.getAllByText(contains(en.deprecatedWarn)).length).toBeGreaterThan(0)
    // The card behind the modal and the modal itself both carry the link.
    expect(screen.getAllByText(en.replacementHint + ' dsh-new').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  })

  it('installed rows warn and offer view/install replacement entries', async () => {
    stubFetch({
      '/dsh-pluginhub/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY },
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-old': '^1.0.0' },
        live: ['dsh-old'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-old': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-old')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(contains(en.deprecatedWarn))).toBeTruthy()
    expect(screen.getByText(en.deprecatedBadge)).toBeTruthy()
    // View replacement jumps to the Discover tab with the new plugin focused.
    fireEvent.click(screen.getByRole('button', { name: en.viewReplacement }))
    await waitFor(() => expect(screen.getByText('dsh-new')).toBeTruthy())
    expect((screen.getByPlaceholderText(en.searchPh) as HTMLInputElement).value).toBe('dsh-new')
  })

  it('install replacement opens the confirm dialog for the new plugin', async () => {
    stubFetch({
      '/dsh-pluginhub/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY },
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { 'dsh-old': '^1.0.0' },
        live: ['dsh-old'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-old': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-old')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const installReplacement = await screen.findByRole('button', { name: en.installReplacement })
    fireEvent.click(installReplacement)
    expect(await screen.findByText('Install dsh-new?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  })
})

describe('installed category and search filters', () => {
  const installed = {
    'dsh-loop': '^1.0.0',
    'dsh-notify': 'github:bob/dsh-notify',
    'whale-skin': 'github:carol/whale-skin',
    'local-addon': 'file:../local-addon',
    'dsh-community-plugins': '^0.1.2',
  }
  function setup(overrides: Record<string, unknown> = {}) {
    stubFetch({
      '/dsh-pluginhub/installed': { installed, notes: { 'dsh-loop': 'daily workflow' } },
      '/dsh-pluginhub/status': { installed, active: false, pnpm: true },
      ...overrides,
    })
  }
  const names = () => Array.from(document.querySelectorAll('[class*="pluginGrid"] [class*="irowNameText"]'), el => el.textContent)

  it('combines categories and search, counts multi-category entries, and preserves filters across tabs', async () => {
    setup()
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: re(en.tabInstalled) }))
    await screen.findByRole('button', { name: 'Skills (1)' })
    expect(names()).toEqual(['dsh-loop', 'dsh-notify', 'whale-skin', 'local-addon'])
    expect(screen.queryByRole('button', { name: /^(List|Groups|New group)$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'All (4)' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Tools (2)' }))
    expect(names()).toEqual(['dsh-loop', 'dsh-notify'])
    const search = screen.getByPlaceholderText(en.searchPh)
    for (const query of [' ALICE ', '循环执行', 'daily workflow', 'Skills']) {
      fireEvent.change(search, { target: { value: query } })
      expect(names()).toEqual(['dsh-loop'])
    }
    fireEvent.change(search, { target: { value: 'carol' } })
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText(en.installedEmpty)).toBeNull()
    fireEvent.change(search, { target: { value: 'alice' } })
    fireEvent.click(screen.getByRole('button', { name: en.tabDiscover }))
    expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', '')
    fireEvent.click(screen.getByRole('button', { name: re(en.tabInstalled) }))
    expect(screen.getByPlaceholderText(en.searchPh)).toHaveProperty('value', 'alice')
    expect(screen.getByRole('button', { name: 'Tools (2)' }).getAttribute('aria-pressed')).toBe('true')
    expect(names()).toEqual(['dsh-loop'])

    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Uncategorized (1)' }))
    expect(names()).toEqual(['local-addon'])
    expect(fetchCalls.some(call => call.path === '/dsh-pluginhub/groups')).toBe(false)
  })

  it('uses the full catalog when Discover has never loaded the installed plugin', async () => {
    const hidden = { ...REGISTRY.plugins[2]!, name: 'hidden-theme', npm: 'hidden-theme', url: 'https://github.com/carol/hidden-theme' }
    const full = { ...REGISTRY, count: 16, plugins: [
      ...Array.from({ length: 15 }, (_, i) => ({ ...REGISTRY.plugins[0]!, name: `tool-${i}`, npm: `tool-${i}`, url: `https://github.com/alice/tool-${i}` })),
      hidden,
    ] }
    setup({
      '/dsh-pluginhub/registry': { registry: full },
      '/dsh-pluginhub/installed': { installed: { 'hidden-theme': '^1.0.0' } },
      '/dsh-pluginhub/status': { installed: { 'hidden-theme': '^1.0.0' }, active: false },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('tool-0')
    expect(screen.queryByText('hidden-theme')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'tool-0' } })
    await waitFor(() => expect(document.querySelectorAll('[class*="pluginGrid"] > *').length).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: re(en.tabInstalled) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Themes (1)' }))
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'carol' } })
    expect(names()).toEqual(['hidden-theme'])
    expect(screen.getByText('Whale theme')).toBeTruthy()
  })

  it('keeps local plugins searchable if the catalog fails and supports retrying', async () => {
    setup({ '/dsh-pluginhub/registry': { __status: 502 } })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: re(en.tabInstalled) }))
    expect(await screen.findByText(en.installedCatalogFail)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'file:../local-addon' } })
    expect(names()).toEqual(['local-addon'])
    setup()
    fireEvent.click(screen.getByRole('button', { name: en.loadRetry }))
    await screen.findByRole('button', { name: 'Tools (2)' })
    expect(screen.queryByText(en.installedCatalogFail)).toBeNull()
    expect(names()).toEqual(['local-addon'])
  })
})

describe('status-poll / install-response race (#73)', () => {
  it('clears the premature pending-restart entry once the install response confirms a hot mount', async () => {
    vi.useFakeTimers()
    try {
      // The /install response is held open (deferred) while the status poll runs.
      let resolveInstall: (value: Response) => void = () => {}
      const installGate = new Promise<Response>(res => { resolveInstall = res })
      vi.stubGlobal('fetch', (url: string) => {
        const path = String(url).split('?')[0]
        const payload =
          path === PLUGINHUB_API_URL ? pluginHubPayload({ source: 'live', registry: REGISTRY }, String(url))
          : path === '/dsh-pluginhub/installed' ? { profile: 'web', installed: {}, live: [] }
          // Poll recovery precondition: host idle AND dsh-loop already installed.
          : path === '/dsh-pluginhub/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: { 'dsh-loop': '^1.0.0' } }
          : path === '/dsh-pluginhub/updates' ? { updates: {} }
          : path === '/dsh-pluginhub/install' ? installGate
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        if (payload instanceof Promise) return payload
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      })
      render(<PluginHubSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      // The module-level installed cache from earlier tests can briefly make
      // dsh-loop look already-installed (no Install button); wait until the
      // mount-time refreshInstalled applies the empty fixture.
      await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
      // Grid order is by stars, not registry order — target dsh-loop's own card.
      let card: HTMLElement | null = screen.getByText('dsh-loop')
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      expect(card).not.toBeNull()
      fireEvent.click(within(card!).getByRole('button', { name: en.install }))
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
      // The /install response is still pending; the 2s status poll now sees
      // idle + installed and the recovery path counts dsh-loop as a pending
      // restart even though the mount may still come back hot.
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0)
        // The premature entry must also be persisted under the current boot.
        expect(sessionStorage.getItem('dsph-restart')).toContain('dsh-loop')
      })
      // The real /install response arrives: hot mount confirmed.
      resolveInstall(new Response(JSON.stringify({
        ok: true,
        hot: true,
        installed: { 'dsh-loop': '^1.0.0' },
        activation: { 'dsh-loop': { state: 'live', reasons: ['live via hot mount'], bundle: true, hot: true } },
      }), { status: 200 }))
      // The stale pending-restart entry must be dropped — both in memory (no
      // restart banner) and in the persisted session state.
      await vi.waitFor(() => {
        expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
        expect(sessionStorage.getItem('dsph-restart')).toBeNull()
      })
      // Stable counterpart: the (now-merged) refresh banner still shows the live mount.
      expect(screen.getAllByText(re(en.refreshBanner)).length).toBeGreaterThan(0)
      // A same-boot remount must not resurrect the banner from stale storage.
      cleanup()
      sessionStorage.removeItem('dsph-tab')
      render(<PluginHubSection {...props()} />)
      await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
      await vi.waitFor(() => {
        expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('uninstall confirmation Modal', () => {
  const installedFixture = {
    '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
    '/dsh-pluginhub/updates': { updates: {} },
  }

  it('cancel does not call the uninstall API', async () => {
    const fetchMock = stubFetch(installedFixture)
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.uninstall }))
    // Modal opens with the confirmation copy.
    expect(await screen.findByText(re(en.uninstallConfirmDesc))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByText(re(en.uninstallConfirmDesc))).toBeNull())
    expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-pluginhub/uninstall')).toBe(false)
  })

  it('confirming in the Modal calls the uninstall API', async () => {
    const fetchMock = stubFetch(installedFixture)
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.uninstall }))
    const dialog = await screen.findByRole('dialog', { name: re(en.uninstall + ' dsh-loop?') })
    fireEvent.click(within(dialog).getByRole('button', { name: en.uninstall }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/dsh-pluginhub/uninstall')).toBe(true))
  })
})

describe('installed two-column table layout', () => {
  it('keeps installed rows in row-first source order', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { alpha: '^1.0.0', beta: '^1.0.0', gamma: '^1.0.0', delta: '^1.0.0' },
        live: [],
      },
      '/dsh-pluginhub/updates': { updates: {} },
    })
    const { container } = render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('delta')

    const grid = container.querySelector('[class*="pluginGrid"]')
    expect(grid).toBeTruthy()
    const names = [...grid!.querySelectorAll('[class*="irowNameText"]')]
      .map(row => row.textContent?.trim())
    expect(names).toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })

  it('uses one grid wrapper instead of JS-created layout columns', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: { alpha: '^1.0.0', beta: '^1.0.0', gamma: '^1.0.0', delta: '^1.0.0' },
        live: [],
      },
      '/dsh-pluginhub/updates': { updates: {} },
    })

    const { container } = render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('delta')

    const grids = [...container.querySelectorAll('[class*="pluginGrid"]')] as HTMLElement[]
    expect(grids).toHaveLength(1)
    expect([...grids[0]!.querySelectorAll('[class*="irowNameText"]')].map(row => row.textContent?.trim()))
      .toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })
})

describe('local-dev restore', () => {
  it('confirms before switching a catalog-matched local package to its online source', async () => {
    stubFetch({
      '/dsh-pluginhub/registry': {
        source: 'live',
        registry: {
          ...REGISTRY,
          plugins: [
            ...REGISTRY.plugins,
            {
              name: 'dsh-better-sidebar', owner: 'flaqai',
              url: 'https://github.com/flaqai/dsh-better-sidebar',
              category: 'tools', npm: 'dsh-better-sidebar', stars: 20,
              added: '2026-08-20', description: { en: 'Better sidebar', zh: '侧边栏增强' }, install: '',
            },
          ],
        },
      },
      '/dsh-pluginhub/installed': {
        profile: 'web', installed: { 'dsh-better-sidebar': 'file:/plugins/dsh-better-sidebar-0.16.1.tgz' }, live: [],
      },
      '/dsh-pluginhub/updates': {
        updates: {
          'dsh-better-sidebar': {
            kind: 'linked', version: '0.16.1', current: '0.16.1', latest: '0.17.1',
            updateAvailable: true, restoreRequired: true,
          },
        },
      },
      '/dsh-pluginhub/update': { ok: true },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(screen.queryByRole('button', { name: en.restore })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: en.restoreOnline }))
    expect(await screen.findByText(en.restoreHint)).toBeTruthy()
    expect(fetchCalls.some(call => call.path === '/dsh-pluginhub/update')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.restoreContinue }))
    await waitFor(() => {
      expect(fetchCalls.some(call =>
        call.path === '/dsh-pluginhub/update'
        && call.body?.name === 'dsh-better-sidebar'
        && call.body?.restore === true,
      )).toBe(true)
    })
  })

  it('leaves source switches out of Update all', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': {
        profile: 'web',
        installed: {
          'dsh-loop': '^1.0.0',
          'dsh-notify': '^1.0.0',
          'dsh-better-sidebar': 'file:/plugins/dsh-better-sidebar-0.16.1.tgz',
        },
        live: [],
      },
      '/dsh-pluginhub/updates': {
        updates: {
          'dsh-loop': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-notify': { kind: 'npm', version: '1.0.0', latest: '1.1.0', updateAvailable: true },
          'dsh-better-sidebar': {
            kind: 'linked', version: '0.16.1', latest: '0.17.1',
            updateAvailable: true, restoreRequired: true,
          },
        },
      },
      '/dsh-pluginhub/update': { ok: true },
    })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Update all \(2\)/ }))
    await waitFor(() => {
      expect(fetchCalls.filter(call => call.path === '/dsh-pluginhub/update')).toHaveLength(2)
    })
    expect(fetchCalls.filter(call => call.path === '/dsh-pluginhub/update').map(call => call.body?.name).sort())
      .toEqual(['dsh-loop', 'dsh-notify'])
    expect(fetchCalls.some(call => call.body?.restore === true)).toBe(false)
  })

  it('asks in the red banner before swapping a linked plugin to the catalog', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': 'link:../dsh-loop' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'linked', version: '1.0.0', updateAvailable: false } } },
      '/dsh-pluginhub/update': { ok: true },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByRole('button', { name: en.uninstall })).toBeTruthy()
    expect(await screen.findByText(en.linkedDev)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: en.restore }))
    expect(await screen.findByText(en.restoreHint)).toBeTruthy()
    expect(fetchCalls.some(call => call.path === '/dsh-pluginhub/update')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.restoreContinue }))
    await waitFor(() => {
      expect(fetchCalls.some(call =>
        call.path === '/dsh-pluginhub/update' && call.body?.name === 'dsh-loop' && call.body?.restore === true,
      )).toBe(true)
    })
  })

  it('does not arm continue when the linked plugin is not in the catalog', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'mystery-plug': 'link:../mystery' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'mystery-plug': { kind: 'linked', updateAvailable: false } } },
    })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    expect(await screen.findByText('mystery-plug')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: en.restore }))
    expect(await screen.findByText(en.restoreNoCatalog)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.restoreContinue })).toBeNull()
    expect(fetchCalls.some(call => call.path === '/dsh-pluginhub/update')).toBe(false)
    expect(screen.getByRole('button', { name: en.uninstall })).toBeTruthy()
  })

  /** #314: the failure is read in the operations panel, and the way out was a
   * banner elsewhere on the page — the message said "click the button above"
   * to someone who could not see one. The record that reports the block now
   * carries the approval itself. */
  it('puts the build approval on the failed record, not only in a banner', async () => {
    stubFetch({
      '/dsh-pluginhub/install': {
        ok: false,
        ignoredBuilds: ['node-pty'],
        error: 'blocked by pnpm',
        __status: 502,
      },
      '/dsh-pluginhub/approve-builds': { ok: true, approved: ['node-pty'] },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    // Two of them now: the banner, and the one on the record in the panel.
    // The panel one is the point — it sits beside the sentence naming it.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: en.approveBuilds }).length).toBeGreaterThan(1)
    })
    // A blocked build offers approval INSTEAD of a bare retry, which would
    // just hit the same wall.
    expect(screen.queryByRole('button', { name: en.opRetry })).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: en.approveBuilds }).at(-1)!)
    await waitFor(() => {
      expect(fetchCalls.some(call => call.path === '/dsh-pluginhub/approve-builds')).toBe(true)
      expect(fetchCalls.filter(call => call.path === '/dsh-pluginhub/install').length).toBeGreaterThanOrEqual(2)
    })
  })

  it('retries a blocked restore with restore:true after approving builds', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': 'link:../dsh-loop' }, live: [] },
      '/dsh-pluginhub/updates': { updates: { 'dsh-loop': { kind: 'linked', updateAvailable: false } } },
      '/dsh-pluginhub/update': {
        ok: false,
        ignoredBuilds: ['dsh-cowork'],
        error: 'not in the allowBuilds allowlist',
        __status: 502,
      },
      '/dsh-pluginhub/approve-builds': { ok: true, approved: ['dsh-cowork'] },
    })
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.restore }))
    fireEvent.click(await screen.findByRole('button', { name: en.restoreContinue }))
    expect(await screen.findByText(re(en.buildsSkipped))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.approveBuilds }))
    await waitFor(() => {
      const retries = fetchCalls.filter(call => call.path === '/dsh-pluginhub/update')
      expect(retries.length).toBeGreaterThanOrEqual(2)
      expect(retries.at(-1)?.body).toMatchObject({ name: 'dsh-loop', restore: true })
    })
  })
})

describe('per-tab search boxes', () => {
  it('the installed tab has its own search that narrows the list', async () => {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' }, live: [] },
      '/dsh-pluginhub/updates': { updates: {} },
    })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText('whale-skin')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'whale' } })
    await waitFor(() => {
      expect(screen.getByText('whale-skin')).toBeTruthy()
      expect(screen.queryByText('dsh-loop')).toBeNull()
    })
    // Clearing restores both rows.
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('dsh-loop')).toBeTruthy())
  })

})

describe('lost install response (#100)', () => {
  it('a rejected install fetch keeps the pending state and the poll recovery lands the success — no false failure', async () => {
    vi.useFakeTimers()
    try {
      // Phase 1: the /install connection DIES (proxy/loopback reset) while
      // the server keeps installing. Status still shows nothing installed.
      let installedNow: Record<string, string> = {}
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        const path = String(url).split('?')[0]
        if (path === '/dsh-pluginhub/install') return Promise.reject(new TypeError('network connection was lost'))
        const payload =
          path === PLUGINHUB_API_URL ? pluginHubPayload({ source: 'live', registry: REGISTRY }, String(url))
          : path === '/dsh-pluginhub/installed' ? { profile: 'web', installed: installedNow, live: [] }
          : path === '/dsh-pluginhub/status' ? { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, installed: installedNow }
          : path === '/dsh-pluginhub/updates' ? { updates: {} }
          : null
        if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
      }))
      render(<PluginHubSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.waitFor(() => { screen.getByRole('button', { name: en.tabInstalled }) })
      const installButtonOf = (name: string) => {
        let card: HTMLElement | null = screen.getByText(name)
        while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
          card = card.parentElement
        }
        return within(card!).getAllByRole('button', { name: en.install })[0]!
      }
      fireEvent.click(installButtonOf('dsh-loop'))
      await vi.waitFor(() => { screen.getByRole('button', { name: en.confirmInstall }) })
      fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
      // The install fetch rejects; the old code showed "install failed" here.
      await vi.advanceTimersByTimeAsync(100)
      expect(screen.queryByText(new RegExp(en.installFail))).toBeNull()
      expect(sessionStorage.getItem('dsph-pending')).toContain('dsh-loop')

      // Phase 2: the server finishes minutes later; the next poll sees the
      // plugin installed and the recovery path completes the flow quietly.
      installedNow = { 'dsh-loop': '^1.0.0' }
      await vi.advanceTimersByTimeAsync(4500)
      await vi.waitFor(() => {
        expect(sessionStorage.getItem('dsph-pending')).toBeNull()
        expect(screen.queryByText(new RegExp(en.installFail))).toBeNull()
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('standing restart notice for host-reported pending plugins', () => {
  function stubWithActivation(boot: string) {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      const installed = { 'dsh-loop': '^1.0.0' }
      const payload =
        path === PLUGINHUB_API_URL ? pluginHubPayload({ source: 'live', registry: REGISTRY }, String(url))
        : path === '/dsh-pluginhub/installed' ? {
            profile: 'web', installed, live: [],
            // The host says: installed, will activate on restart.
            activation: { 'dsh-loop': { state: 'restart', reasons: ['in the bundle layer'], bundle: true, hot: false } },
          }
        : path === '/dsh-pluginhub/status' ? { active: false, busy: false, pnpm: true, boot, restart: true, installed }
        : path === '/dsh-pluginhub/updates' ? { updates: {} }
        : null
      if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }))
  }

  it('shows the notice after a reload with no session memory, and can be dismissed', async () => {
    // The gap this closes: install, reload, and the page told you a restart
    // was needed while offering nothing to press.
    stubWithActivation('boot-1')
    render(<PluginHubSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
    expect(screen.getByRole('button', { name: en.restartNow })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.dismissNotice }))
    await waitFor(() => { expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0) })
    expect(sessionStorage.getItem('dsph-restart-dismissed')).toBe('boot-1')
  })

  it('reappears on the next boot, because the restart never happened', async () => {
    sessionStorage.setItem('dsph-restart-dismissed', 'boot-1')
    stubWithActivation('boot-2')
    render(<PluginHubSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
  })

  it('stays quiet when nothing is pending', async () => {
    stubFetch()
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    expect(screen.queryAllByText(re(en.restartBanner)).length).toBe(0)
  })

  it('shows the restart banner but hides the button while the host is debugged (#447)', async () => {
    stubWithActivation('boot-1')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url).split('?')[0]
      const installed = { 'dsh-loop': '^1.0.0' }
      const payload =
        path === PLUGINHUB_API_URL ? pluginHubPayload({ source: 'live', registry: REGISTRY }, String(url))
        : path === '/dsh-pluginhub/installed' ? {
            profile: 'web', installed, live: [],
            activation: { 'dsh-loop': { state: 'restart', reasons: ['in the bundle layer'], bundle: true, hot: false } },
          }
        : path === '/dsh-pluginhub/status' ? { active: false, busy: false, pnpm: true, boot: 'boot-1', restart: true, debugger: 'inspector', installed }
        : path === '/dsh-pluginhub/updates' ? { updates: {} }
        : null
      if (payload === null) return Promise.reject(new Error(`unstubbed fetch: ${String(url)}`))
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }))
    render(<PluginHubSection {...props()} />)
    await waitFor(() => { expect(screen.getAllByText(re(en.restartBanner)).length).toBeGreaterThan(0) })
    expect(screen.queryByRole('button', { name: en.restartNow })).toBeNull()
  })
})

describe('boot-scoped update reminder dismissals (#419)', () => {
  const installed = {
    'dsh-community-plugins': '^1.38.0',
    'dsh-loop': '^1.0.0',
    'dsh-notify': '^1.0.0',
  }
  const updateStatuses = {
    'dsh-community-plugins': { kind: 'npm', current: '1.38.0', latest: '1.39.0', updateAvailable: true },
    'dsh-loop': { kind: 'npm', current: '1.0.0', latest: '1.1.0', updateAvailable: true },
    'dsh-notify': { kind: 'npm', current: '1.0.0', latest: '1.1.0', updateAvailable: true },
  }

  function stubUpdateReminders(boot = 'boot-1') {
    stubFetch({
      '/dsh-pluginhub/installed': { profile: 'web', installed, live: Object.keys(installed) },
      '/dsh-pluginhub/status': { active: false, busy: false, pnpm: true, boot, restart: true, installed },
      '/dsh-pluginhub/updates': { updates: updateStatuses },
    })
  }

  const installedTab = () => screen.getByRole('button', { name: /^Installed \(2\)/ })
  const updateDot = () => installedTab().querySelector('[class*="dot"]')

  it('dismisses one plugin without hiding its Installed-row information or update action', async () => {
    stubUpdateReminders()
    render(<PluginHubSection {...props()} />)
    expect(await screen.findByRole('button', { name: /Update all \(2\)/ })).toBeTruthy()
    expect(updateDot()).toBeTruthy()

    fireEvent.click(installedTab())
    fireEvent.click(await screen.findByRole('button', { name: `${en.ignoreUpdateNotice} dsh-loop` }))

    expect(JSON.parse(sessionStorage.getItem('dsph-updates-ignored')!)).toEqual({
      boot: 'boot-1', names: ['dsh-loop'],
    })
    expect(await screen.findByText(en.updateNoticeIgnored)).toBeTruthy()
    // Ignoring means "do not prompt", not "remove the update".
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: re(en.notesLink) })).toHaveLength(2)
    // dsh-notify is still unignored, so the tab continues to carry its dot.
    expect(updateDot()).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Update all \(2\)/ })).toBeNull()
  })

  it('ignores all current reminders while preserving the complete Installed update list', async () => {
    stubUpdateReminders()
    render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: en.pluginHubUpdate })).toBeNull()
      expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull()
      expect(updateDot()).toBeNull()
    })
    expect(new Set(JSON.parse(sessionStorage.getItem('dsph-updates-ignored')!).names))
      .toEqual(new Set(['dsh-community-plugins', 'dsh-loop', 'dsh-notify']))

    fireEvent.click(installedTab())
    expect(await screen.findAllByText(en.updateNoticeIgnored)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: en.update })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: re(en.notesLink) })).toHaveLength(2)
  })

  it('keeps reminders dismissed after a page remount in the same boot', async () => {
    stubUpdateReminders('boot-1')
    const first = render(<PluginHubSection {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices }))
    await waitFor(() => expect(updateDot()).toBeNull())
    first.unmount()

    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: en.ignoreAllUpdateNotices })).toBeNull()
      expect(screen.queryByRole('button', { name: en.pluginHubUpdate })).toBeNull()
      expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull()
      expect(updateDot()).toBeNull()
    })
  })

  it('invalidates an old dismissal after the host boot changes', async () => {
    sessionStorage.setItem('dsph-updates-ignored', JSON.stringify({
      boot: 'boot-1', names: ['dsh-community-plugins', 'dsh-loop', 'dsh-notify'],
    }))
    stubUpdateReminders('boot-2')
    render(<PluginHubSection {...props()} />)

    expect(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.pluginHubUpdate })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Update all \(2\)/ })).toBeTruthy()
    expect(updateDot()).toBeTruthy()
    expect(sessionStorage.getItem('dsph-updates-ignored')).toBeNull()
  })

  it('fails open when the stored dismissal is malformed', async () => {
    sessionStorage.setItem('dsph-updates-ignored', '{not-json')
    stubUpdateReminders()
    render(<PluginHubSection {...props()} />)

    expect(await screen.findByRole('button', { name: en.ignoreAllUpdateNotices })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Update all \(2\)/ })).toBeTruthy()
    expect(updateDot()).toBeTruthy()
    expect(sessionStorage.getItem('dsph-updates-ignored')).toBeNull()
  })
})

/**
 * The pnpm setup banner (#142). Before any plugin can be installed the
 * pluginhub may have to provision pnpm, and the banner is the whole interface
 * for that: it offers the one-click fix, and after a failed attempt it has
 * to stop offering it and point at the log instead — a button that keeps
 * failing is worse than no button.
 *
 * Neither state was asserted; a mutation audit could invert the condition
 * that hides the button and nothing failed.
 */
describe('pnpm setup banner', () => {
  const notReady = { active: false, pnpm: false, boot: 'boot-1', restart: true, installed: {} }

  it('offers the one-click fix while setup is still worth trying', async () => {
    stubFetch({ '/dsh-pluginhub/status': notReady })
    render(<PluginHubSection {...props()} />)
    await waitFor(() => expect(screen.getByText(re(en.envMissing))).toBeTruthy())
    expect(screen.getByRole('button', { name: re(en.envFix) })).toBeTruthy()
  })

  it('after a failed setup, explains and stops offering the button', async () => {
    stubFetch({ '/dsh-pluginhub/status': notReady, '/dsh-pluginhub/setup-pnpm': { ok: false, error: 'no Node found' } })
    render(<PluginHubSection {...props()} />)
    await waitFor(() => expect(screen.getByText(re(en.envMissing))).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: re(en.envFix) }))
    await waitFor(() => expect(screen.getByText(re(en.envFixFail))).toBeTruthy())
    // The retry button is gone, and the host's reason is surfaced verbatim.
    expect(screen.queryByRole('button', { name: re(en.envFix) })).toBeNull()
    expect(screen.getByText(re('no Node found'))).toBeTruthy()
  })

  it('clears the banner when setup succeeds', async () => {
    stubFetch({ '/dsh-pluginhub/status': notReady, '/dsh-pluginhub/setup-pnpm': { ok: true } })
    render(<PluginHubSection {...props()} />)
    await waitFor(() => expect(screen.getByText(re(en.envMissing))).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: re(en.envFix) }))
    await waitFor(() => expect(screen.queryByText(re(en.envMissing))).toBeNull())
    expect(screen.queryByText(re(en.envFixFail))).toBeNull()
  })
})

/**
 * A failed install has to END. #138 reported the opposite: the spinner ran
 * forever with no message, while pnpm had already refused the spec
 * instantly. This is the plain case — the host answered, and it answered
 * "no". A LOST response is deliberately NOT this case (#100: pnpm often
 * keeps working after the connection drops, so the status poll decides);
 * its recovery has its own spec above.
 *
 * Both halves matter. Releasing the button without showing why leaves the
 * user guessing; showing the error while the row still says "installing"
 * leaves them waiting for something that already finished.
 */
describe('a failed install releases the UI and says why', () => {
  const failure = {
    ok: false,
    error: '[ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER] "whatever" isn\'t supported by any available resolver.',
  }

  it('stops the spinner and surfaces the host error', async () => {
    stubFetch({ '/dsh-pluginhub/install': failure })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')

    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))

    // The reason reaches the page verbatim — a resolver error names the spec
    // that was refused, which is the only clue the user has.
    await waitFor(() => expect(screen.getByText(re('isn\'t supported by any available resolver'))).toBeTruthy())
    // ...and nothing is left claiming to be in progress.
    expect(screen.queryByRole('button', { name: en.installing })).toBeNull()
    expect(screen.getAllByRole('button', { name: en.install }).length).toBeGreaterThan(0)
  })
})

/**
 * A loader-id clash (#122) is the one install failure the user can act on:
 * in a single profile the plugins cannot coexist, so the choice is which one
 * to keep. The decision lives in the activity panel, which no page change can
 * take away; the card keeps only a marker pointing at it.
 */
describe('a loader-id clash becomes a decision in the activity panel', () => {
  const clash = {
    ok: false,
    conflictGroups: [{ owner: 'dsh-tui-core', ids: ['storage', 'terminal'] }],
    error: 'PROSE-FALLBACK-FOR-LOGS',
  }

  /** Install the first card, then follow its marker into the panel. */
  const installFirstCard = async () => {
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    // The card must say something: one that looks untouched invites pressing
    // Install again, which is how the same clash gets hit twice.
    fireEvent.click(await screen.findByRole('button', { name: re(en.opBlockedCard) }))
    await screen.findByText(re(en.conflictBody))
  }

  it('names the clashing plugin, and keeps entry ids out of the decision', async () => {
    stubFetch({ '/dsh-pluginhub/install': clash })
    await installFirstCard()

    expect(screen.getByText('dsh-tui-core')).toBeTruthy()
    // Entry ids are evidence, not part of the choice: a reader deciding which
    // plugin to keep does not need them, so they live behind the disclosure.
    expect(screen.queryByText(re('storage, terminal'))).toBeNull()
    fireEvent.click(screen.getByText(en.conflictDetails))
    expect(screen.getByText(re('storage, terminal'))).toBeTruthy()
    // "Nothing was changed" is what keeps this from reading as "something was
    // removed and I do not know what" — it rides on the status line now,
    // rather than as a row of its own inside the decision.
    expect(screen.getByText(re(en.opNeedsChoice))).toBeTruthy()
    // The record survives a page change, which is the whole reason it moved
    // off the card.
    fireEvent.click(screen.getByRole('button', { name: en.tabInstalled }))
    expect(screen.getByText(re(en.conflictBody))).toBeTruthy()
    // The host still sends a prose string for logs; rendering it as well
    // would report the same failure twice, in two different registers.
    expect(screen.queryByText(re('PROSE-FALLBACK-FOR-LOGS'))).toBeNull()
  })

  it('lists one row per owner when a candidate clashes with several at once', async () => {
    stubFetch({ '/dsh-pluginhub/install': { ok: false, conflictGroups: [
      { owner: 'dsh-tui-core', ids: ['storage'] },
      { owner: 'dsh-panel-kit', ids: ['panel'] },
    ] } })
    await installFirstCard()

    // Both owners, each with only the id it actually declares — the whole
    // point of grouping rather than listing every id against the first name.
    expect(screen.getByText('dsh-tui-core')).toBeTruthy()
    expect(screen.getByText('dsh-panel-kit')).toBeTruthy()
    // Grouping still holds under the disclosure: each owner keeps only the
    // ids it actually declares.
    fireEvent.click(screen.getByText(en.conflictDetails))
    expect(screen.getByText(re('dsh-tui-core: storage'))).toBeTruthy()
    expect(screen.getByText(re('dsh-panel-kit: panel'))).toBeTruthy()
  })

  it('draws the outcome on the plugins, and flips it with the choice', async () => {
    // Stating a consequence beside a list leaves the reader to apply it. Here
    // the list IS the consequence: the side that loses is struck through and
    // tagged, so the choice can be read without parsing a sentence.
    stubFetch({ '/dsh-pluginhub/install': clash })
    await installFirstCard()

    // Scoped to the decision: the plugin name also appears on the card.
    const decision = screen.getByText(re(en.conflictBody)).parentElement as HTMLElement
    const rowOf = (name: string) => within(decision).getByTitle(name).closest('div')?.parentElement
    // Default keeps what is installed: the candidate is the one dropped.
    expect(rowOf('dsh-loop')?.textContent).toContain(en.conflictOutcomeSkip)
    expect(rowOf('dsh-tui-core')?.textContent).toContain(en.conflictOutcomeKeep)

    fireEvent.click(screen.getByRole('radio', { name: re(en.conflictSwap) }))
    expect(rowOf('dsh-loop')?.textContent).toContain(en.conflictOutcomeInstall)
    expect(rowOf('dsh-tui-core')?.textContent).toContain(en.conflictOutcomeRemove)
  })

  it('closes on Escape, on an outside click, and from its own header', async () => {
    // Re-pressing the control that opened a popover is the one dismissal
    // route nobody looks for, so it cannot be the only one.
    stubFetch({ '/dsh-pluginhub/install': clash })
    await installFirstCard()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(re(en.conflictBody))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: re(en.opBlockedCard) }))
    await screen.findByText(re(en.conflictBody))
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByText(re(en.conflictBody))).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: re(en.opBlockedCard) }))
    await screen.findByText(re(en.conflictBody))
    fireEvent.click(screen.getByRole('button', { name: en.opClose }))
    await waitFor(() => expect(screen.queryByText(re(en.conflictBody))).toBeNull())
  })

  it('defaults to the outcome that changes nothing, and confirming it uninstalls nothing', async () => {
    // The destructive option is one click away, so the default carries the
    // whole safety of this screen: confirming without touching it must not
    // remove a working plugin.
    stubFetch({ '/dsh-pluginhub/install': clash, '/dsh-pluginhub/uninstall': { ok: true, installed: {} } })
    await installFirstCard()

    expect((screen.getByRole('radio', { name: re(en.conflictKeep) }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: re(en.conflictSwap) }) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => expect(screen.queryByText(en.conflictTitle)).toBeNull())
    expect(fetchCalls.filter(call => call.path === '/dsh-pluginhub/uninstall')).toEqual([])
  })

  it('swaps: uninstalls what clashed, then retries the install', async () => {
    let installs = 0
    stubFetch({
      '/dsh-pluginhub/install': () => {
        installs += 1
        return installs === 1 ? clash : { ok: true, hot: true, activation: {}, installed: {} }
      },
      '/dsh-pluginhub/uninstall': { ok: true, hot: true, installed: {} },
    })
    await installFirstCard()

    // The safe outcome is preselected, so the swap only happens once the
    // user actively moves off it.
    fireEvent.click(screen.getByRole('radio', { name: re(en.conflictSwap) }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))

    await waitFor(() => expect(installs).toBe(2))
    expect(fetchCalls.filter(call => call.path === '/dsh-pluginhub/uninstall').map(call => call.body))
      .toEqual([{ name: 'dsh-tui-core' }])
  })

  it('names the plugins already removed when the swap dies part-way', async () => {
    // The honest half: nothing reinstalls them, so a bare "failed" would
    // leave the user guessing which of their plugins survived.
    let removes = 0
    stubFetch({
      '/dsh-pluginhub/install': { ok: false, conflictGroups: [
        { owner: 'a-plug', ids: ['x'] },
        { owner: 'b-plug', ids: ['y'] },
      ] },
      '/dsh-pluginhub/uninstall': () => {
        removes += 1
        return removes === 1 ? { ok: true, installed: {} } : { ok: false, error: 'EBUSY' }
      },
    })
    await installFirstCard()

    fireEvent.click(screen.getByRole('radio', { name: re(en.conflictSwap) }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))

    // Reported once, in the panel: the page banner no longer echoes an
    // operation's outcome now that a record owns it.
    await waitFor(() => expect(screen.getByText(re(en.conflictReplaceFailed))).toBeTruthy())
    expect(screen.getByText(re('a-plug'))).toBeTruthy()
  })
})

describe('category strip', () => {
  it('keeps every category in protocol order when a category is selected', async () => {
    const registry = { ...REGISTRY, categories: PLUGINHUB_CATEGORIES, plugins: [
      { ...REGISTRY.plugins[0], category: 'agent' },
    ] }
    const fetchMock = stubFetch({ '/dsh-pluginhub/registry': registry })
    const { container } = render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    const chipLabels = () => [...container.querySelectorAll('[data-chip="1"]')]
      .slice(1).map(el => el.textContent?.trim())
    const expected = Object.entries(PLUGINHUB_CATEGORIES).filter(([id]) => id !== 'all').map(([, label]) => label.en)
    expect(chipLabels()).toEqual(expected)
    fireEvent.click(screen.getByRole('button', { name: 'Agent capability', exact: true }))
    await screen.findByText('dsh-loop')
    expect(chipLabels()).toEqual(expected)
    const requests = fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'))
      .filter(url => url.origin + url.pathname === PLUGINHUB_API_URL)
    expect(requests.at(-1)!.searchParams.get('category')).toBe('agent')
    expect(requests.at(-1)!.searchParams.get('page')).toBe('1')
  })
})

describe('install-detail screenshots + lightbox', () => {
  const SHOT_A = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/a.png'
  const SHOT_B = 'https://raw.githubusercontent.com/alice/dsh-loop/main/assets/b.png'
  const detailThumb = (src: string) => `https://images.weserv.nl/?url=${encodeURIComponent(src.replace(/^https?:\/\//, ''))}&h=300&fit=inside&we=1`

  function registryWithShots() {
    const registry = JSON.parse(JSON.stringify(REGISTRY))
    registry.plugins[0].screenshots = [SHOT_A, SHOT_B]
    registry.plugins[0].downloads = 4200
    registry.plugins[0].install = 'dsh plugin --profile web add github:alice/dsh-loop'
    return registry
  }

  async function openInstallDetails(): Promise<HTMLElement> {
    await screen.findByText('dsh-loop')
    let card: HTMLElement | null = screen.getByText('dsh-loop')
    while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
      card = card.parentElement
    }
    fireEvent.click(within(card!).getByRole('button', { name: en.install }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.querySelectorAll('img[class*="shot"]').length).toBe(2))
    return dialog
  }

  it('keeps screenshots out of table cards and shows them in install details', async () => {
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
    const { container } = render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')
    expect(container.querySelectorAll('img[class*="cardShot"]')).toHaveLength(0)

    const dialog = await openInstallDetails()
    const shots = dialog.querySelectorAll('img[class*="shot"]')
    expect(shots.length).toBe(2)
    expect(shots[0]?.getAttribute('src')).toBe(detailThumb(SHOT_A))
    expect(shots[1]?.getAttribute('src')).toBe(detailThumb(SHOT_B))
  })

  it('portals into a container of its own, never straight into document.body (#293)', async () => {
    // The host's settings dialog is a separate React root that also portals
    // to document.body. Two roots adding and removing children of the SAME
    // container interleave in an order neither models: the host's root then
    // calls removeChild for a node this one already moved, React throws
    // NotFoundError, the settings.section slot catches it, and the panel
    // goes blank. Three reporters hit that (#293, #286, #241).
    //
    // The fix is structural, so this asserts the structure — the crash
    // itself depends on mount ordering that varies per host and cannot be
    // pinned down in jsdom.
    resetPluginHubPortalHost()
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
    render(<PluginHubSection {...props()} />)
    const dialog = await openInstallDetails()
    fireEvent.click(dialog.querySelector('img[class*="shot"]')!)
    const img = await waitFor(() => {
      const found = document.querySelector('[class*="lightboxImg"]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })

    const own = document.querySelector('[data-dsh-pluginhub-portal]')
    expect(own, 'no owned portal container was created').toBeTruthy()
    expect(own!.contains(img), 'the lightbox mounted outside the container this package owns').toBe(true)
    // And it is body's LAST child: the stacking guarantee the portal exists
    // for, which a plain z-index cannot win against another portal.
    expect(document.body.lastElementChild).toBe(own)
  })

  it('keeps one container, last in body, across repeated opens', async () => {
    // The container is created during render (createPortal needs a target) but
    // MOVED into body from a layout effect — see usePluginHubPortalHost. What is
    // observable from here is the invariant that move exists to hold: exactly
    // one container, always body's last child, however many times the preview
    // is opened. A second container, or one that drifts off the end, is the
    // shared-child-list churn between two React roots that #293 was about.
    resetPluginHubPortalHost()
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
    render(<PluginHubSection {...props()} />)
    const dialog = await openInstallDetails()

    for (let i = 0; i < 3; i++) {
      fireEvent.click(dialog.querySelector('img[class*="shot"]')!)
      await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
      expect(document.querySelectorAll('[data-dsh-pluginhub-portal]').length,
        'a second portal container was created').toBe(1)
      expect(document.body.lastElementChild,
        'the container drifted off the end of body').toBe(document.querySelector('[data-dsh-pluginhub-portal]'))
      fireEvent.click(document.querySelector('[class*="lightboxClose"]')!)
      await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeNull())
    }
  })

  it('opens a lightbox on click, at the clicked shot, and wraps prev/next around the ends', async () => {
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
    render(<PluginHubSection {...props()} />)
    const dialog = await openInstallDetails()

    fireEvent.click(dialog.querySelector('img[class*="shot"]')!)
    // The lightbox portals into a container this package owns (so it always stacks above the
    // Settings Modal, which portals there too) — no longer inside `container`.
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
    const img = () => document.querySelector('[class*="lightboxImg"]') as HTMLImageElement
    expect(img().src).toBe(SHOT_A)

    fireEvent.click(document.querySelector('[class*="lightboxNext"]')!)
    expect(img().src).toBe(SHOT_B)
    // Two shots total — next again wraps back to the first, not off the end.
    fireEvent.click(document.querySelector('[class*="lightboxNext"]')!)
    expect(img().src).toBe(SHOT_A)
    // Prev from the first wraps to the last, the same way.
    fireEvent.click(document.querySelector('[class*="lightboxPrev"]')!)
    expect(img().src).toBe(SHOT_B)
  })

  it('does not auto-advance the lightbox — a full-bleed preview stays put until the viewer moves on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
      render(<PluginHubSection {...props()} />)
      const dialog = await openInstallDetails()

      fireEvent.click(dialog.querySelector('img[class*="shot"]')!)
      await vi.waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
      const img = () => document.querySelector('[class*="lightboxImg"]') as HTMLImageElement
      expect(img().src).toBe(SHOT_A)
      await vi.advanceTimersByTimeAsync(10_000)
      // The preview is on demand: nothing may page past the shot the viewer
      // is reading. Manual navigation (arrows/dots/keys) is what moves it.
      expect(img().src).toBe(SHOT_A)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes only the lightbox on Escape, leaving the dialog underneath open', async () => {
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
    render(<PluginHubSection {...props()} />)
    const dialog = await openInstallDetails()

    fireEvent.click(dialog.querySelector('img[class*="shot"]')!)
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[class*="lightboxImg"]')).toBeNull())
    expect(screen.getByRole('dialog')).toBe(dialog)
  })

  it('keeps every install-detail screenshot mounted in source order', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
      render(<PluginHubSection {...props()} />)
      const dialog = await openInstallDetails()

      const srcs = () => [...dialog.querySelectorAll('img[class*="shot"]')].map(el => (el as HTMLImageElement).src)
      expect(srcs()).toEqual([detailThumb(SHOT_A), detailThumb(SHOT_B)])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(srcs()).toEqual([detailThumb(SHOT_A), detailThumb(SHOT_B)])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the confirm dialog shows the card\'s own byline — owner, downloads, stars, date, category', async () => {
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: registryWithShots() } })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')

    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })

    // The card behind the dialog carries the same fields — scope to the
    // dialog so this proves the MODAL shows them, not just the grid.
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('alice')).toBeTruthy()
    expect(dialog.getByText(/4\.2k/)).toBeTruthy()
    expect(dialog.getByText(/50/)).toBeTruthy()
    expect(dialog.getByText(/2026-08-01/)).toBeTruthy()
    expect(dialog.getByText('Tools')).toBeTruthy()
  })

  it('lets the "Install command" row expand by clicking its title text, not only its icon (expandOnRowClick)', async () => {
    const registry = registryWithShots()
    const installCmd = registry.plugins[0].install as string
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry } })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')

    const installButtonOf = (name: string) => {
      let card: HTMLElement | null = screen.getByText(name)
      while (card !== null && within(card).queryAllByRole('button', { name: en.install }).length === 0) {
        card = card.parentElement
      }
      return within(card!).getAllByRole('button', { name: en.install })[0]!
    }
    fireEvent.click(installButtonOf('dsh-loop'))
    await screen.findByRole('button', { name: en.confirmInstall })

    expect(screen.queryByText(installCmd)).toBeNull()
    fireEvent.click(screen.getByText(re(en.cmdDetails)))
    await waitFor(() => expect(screen.getByText(installCmd)).toBeTruthy())
  })

  it('offers a Retry button on a catalog load failure, which re-fetches and recovers (#188)', async () => {
    let calls = 0
    stubFetch({
      '/dsh-pluginhub/registry': () => {
        calls++
        return calls === 1
          ? { __status: 500, error: 'HTTP 500' }
          : { source: 'live', registry: REGISTRY }
      },
    })
    render(<PluginHubSection {...props()} />)

    await screen.findByText(en.loadFail)
    expect(screen.getByText('HTTP 500')).toBeTruthy()
    expect(calls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: en.loadRetry }))

    await screen.findByText('dsh-loop')
    expect(screen.queryByText(en.loadFail)).toBeNull()
    expect(calls).toBe(2)
  })
})

describe('card owner name and description overflow', () => {
  it('carries the full owner name in a title attribute, even once CSS ellipsizes it', async () => {
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: REGISTRY } })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')

    const card = screen.getByText('dsh-loop').closest('[class*="card"]') as HTMLElement
    const owner = within(card).getByText('alice')
    expect(owner.getAttribute('title')).toBe('alice')
  })

  it('clamps a long description by default and shows nothing to expand for a short one', async () => {
    stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: REGISTRY } })
    render(<PluginHubSection {...props()} />)
    await screen.findByText('dsh-loop')

    // jsdom never lays anything out, so scrollHeight === clientHeight (both
    // 0) for every element — the real "does this overflow 5 lines" check
    // can only be exercised with the two properties stubbed, done below.
    expect(screen.queryByLabelText(re(en.descExpand))).toBeNull()
  })

  it('offers an expand/collapse toggle only once the clamped text actually overflows, and it flips the clamp', async () => {
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('desc') ? 90 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.className.includes('desc') ? 54 : 0 },
    })
    try {
      stubFetch({ '/dsh-pluginhub/registry': { source: 'live', registry: REGISTRY } })
      const { container } = render(<PluginHubSection {...props()} />)
      await screen.findByText('dsh-loop')

      const toggle = screen.getAllByLabelText(re(en.descExpand))[0]!
      const desc = () => container.querySelector('[class*="desc"]:not([class*="descTight"])')
      expect(desc()?.className).toMatch(/descClamp/)

      fireEvent.click(toggle)
      await waitFor(() => expect(screen.queryAllByLabelText(re(en.descCollapse)).length).toBeGreaterThan(0))
      expect(desc()?.className).not.toMatch(/descClamp/)

      fireEvent.click(screen.getAllByLabelText(re(en.descCollapse))[0]!)
      await waitFor(() => expect(screen.queryAllByLabelText(re(en.descExpand)).length).toBeGreaterThan(0))
      expect(desc()?.className).toMatch(/descClamp/)
    } finally {
      if (scrollHeightDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDesc)
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDesc)
    }
  })
})
