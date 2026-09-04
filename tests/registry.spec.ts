/** Remote catalog parsing, request caching, revalidation and lifecycle behavior. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_TTL_MS, createRegistryClient, describeFetchFailure, forgetCatalog, loadRegistry, loadRegistryPlugin } from '../src/registry.ts'
import { configuredProxy, pluginHubFetch } from '../src/net.ts'

/**
 * undici stands in for the real outbound path. `pluginHubFetch` routes through
 * EnvHttpProxyAgent only when a proxy is configured, and the assertion that
 * matters is exactly which proxy URLs the agent was built with —
 * npm_config_* is invisible to EnvHttpProxyAgent, so the explicit handoff
 * is what makes the npm fallback real instead of a name the failure message
 * claims was tried.
 */
const undici = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response('ok', { status: 200 })),
  EnvHttpProxyAgent: vi.fn(function (this: unknown, opts?: unknown) {
    return { opts }
  }),
}))

vi.mock('undici', () => ({
  fetch: undici.fetch,
  EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
}))

const CATALOG = {
  updated: '2026-08-18',
  count: 1,
  categories: { tools: { en: 'Tools', zh: '工具' } },
  plugins: [{
    name: 'dsh-loop', owner: 'someone', url: 'https://example.com', category: 'tools',
    description: { en: 'a plugin' }, install: 'dsh-loop', added: '2026-01-01',
  }],
}

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
const PLUGINHUB_PLUGIN = {
  name: 'dsh-loop',
  owner: 'someone',
  url: 'https://github.com/someone/dsh-loop',
  page: 'https://dshpluginhub.com/plugins/someone/dsh-loop/',
  category: 'development',
  description: { en: 'a plugin', zh: '一个插件' },
  npm: null,
  tarball: null,
  stars: 12,
  downloads: null,
  install: 'dsh plugin --profile web add github:someone/dsh-loop',
  added: '2026-09-03',
  updatedAt: '2026-09-03T00:00:00Z',
  installable: true,
  isVerified: true,
  validationStatus: 'verified',
  validationReason: '',
  requiresBuildAuthorization: false,
}
const pluginHubPage = (
  plugins: unknown[] = [PLUGINHUB_PLUGIN],
  pagination = { page: 1, pageSize: 48, total: plugins.length, totalPages: 1, hasMore: false },
) => ({
  name: 'dsh-plugin-hub',
  url: 'https://dshpluginhub.com',
  source: 'https://github.com/funcodingdev/dsh-plugin-hub',
  updated: '2026-09-03',
  count: plugins.length,
  categories: PLUGINHUB_CATEGORIES,
  sorts: PLUGINHUB_SORTS,
  plugins,
  pagination,
})

/** Every proxy variable — standard and npm's own config — so one test's environment cannot leak into another. */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'npm_config_https_proxy', 'npm_config_proxy', 'npm_config_noproxy', 'DSH_PLUGINHUB_REGISTRY_URL'] as const
let savedProxy: Record<string, string | undefined> = {}

beforeEach(() => {
  forgetCatalog()
  savedProxy = {}
  for (const key of PROXY_VARS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
})
afterEach(() => {
  for (const key of PROXY_VARS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Headers sent on each call, in order — what a conditional request needs. */
let sent: Array<Record<string, string>> = []

/** A fetch that plays the given script, one entry per call. */
function scriptedFetch(...answers: Array<Response | Error>): ReturnType<typeof vi.fn> {
  let call = 0
  sent = []
  const stub = vi.fn((_url: unknown, init?: { headers?: Record<string, string> }) => {
    sent.push({ ...init?.headers })
    const answer = answers[Math.min(call, answers.length - 1)]
    call += 1
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone())
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

/** A 200 carrying the validators the real origin serves. */
const okTagged = (body: unknown, etag: string | null, modified?: string): Response => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (etag !== null) headers.etag = etag
  if (modified !== undefined) headers['last-modified'] = modified
  return new Response(JSON.stringify(body), { status: 200, headers })
}

/** What the origin sends when nothing changed: a status and no body at all. */
const notModified = (): Response => new Response(null, { status: 304 })

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('loadRegistry', () => {
  beforeEach(() => { process.env.DSH_PLUGINHUB_REGISTRY_URL = 'https://example.test/catalog.json' })

  it('reuses the remote response within the cache lifetime', async () => {
    const stub = scriptedFetch(ok(CATALOG))
    await loadRegistry()
    await loadRegistry()
    await loadRegistry()
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('normalizes legacy and multi-value categories in declaration order', async () => {
    const catalog = {
      ...CATALOG,
      count: 2,
      categories: { tools: { en: 'Tools' }, skill: { en: 'Skills' } },
      plugins: [
        CATALOG.plugins[0],
        { ...CATALOG.plugins[0], name: 'dsh-skills', category: [null, 'skill', 'tools', 'skill'] },
      ],
    }
    scriptedFetch(ok(catalog))

    const registry = await loadRegistry()
    expect(registry.plugins.map(plugin => plugin.category)).toEqual([
      ['tools'],
      ['skill', 'tools'],
    ])
  })

  it('reads semantic categories and independent sorts from the public protocol', async () => {
    delete process.env.DSH_PLUGINHUB_REGISTRY_URL
    scriptedFetch(ok(pluginHubPage()))

    const registry = await loadRegistry()
    expect(registry.updated).toBe('2026-09-03')
    expect(registry.count).toBe(1)
    expect(registry.categories.development?.en).toBe('Developer tools')
    expect(registry.sorts?.stars?.en).toBe('Most Stars')
    expect(registry.plugins[0]).toMatchObject({
      name: 'dsh-loop',
      owner: 'someone',
      category: 'development',
      installable: true,
      isVerified: true,
    })
  })

  it('requests and assembles public API pages in protocol order', async () => {
    delete process.env.DSH_PLUGINHUB_REGISTRY_URL
    const second = { ...PLUGINHUB_PLUGIN, name: 'dsh-two', url: 'https://github.com/someone/dsh-two', category: 'agent' }
    const stub = scriptedFetch(
      ok(pluginHubPage([PLUGINHUB_PLUGIN], { page: 1, pageSize: 1, total: 2, totalPages: 2, hasMore: true })),
      ok(pluginHubPage([second], { page: 2, pageSize: 1, total: 2, totalPages: 2, hasMore: false })),
    )

    const registry = await loadRegistry()
    expect(registry.plugins.map(plugin => plugin.name)).toEqual(['dsh-loop', 'dsh-two'])
    const firstUrl = new URL(String(stub.mock.calls[0]?.[0]))
    expect(Object.fromEntries(firstUrl.searchParams)).toMatchObject({
      category: 'all', sort: 'recommended', page: '1', pageSize: '48', verifiedOnly: 'false',
    })
    expect(new URL(String(stub.mock.calls[1]?.[0])).searchParams.get('page')).toBe('2')
  })

  it('keeps unverified entries when a configured list URL contains a verification filter', async () => {
    process.env.DSH_PLUGINHUB_REGISTRY_URL = 'https://dshpluginhub.com/api/marketplace/plugins?verifiedOnly=true'
    const pending = { ...PLUGINHUB_PLUGIN, isVerified: false, installable: false, validationStatus: 'pending' }
    const stub = scriptedFetch(ok(pluginHubPage([pending])))
    const registry = await loadRegistry()
    expect(registry.plugins[0]).toMatchObject({ isVerified: false, validationStatus: 'pending' })
    expect(new URL(String(stub.mock.calls[0]?.[0])).searchParams.getAll('verifiedOnly')).toEqual(['false'])
  })

  it('accepts a successful empty pluginhub without retrying', async () => {
    delete process.env.DSH_PLUGINHUB_REGISTRY_URL
    const stub = scriptedFetch(ok(pluginHubPage([], {
      page: 1, pageSize: 48, total: 0, totalPages: 0, hasMore: false,
    })))
    await expect(loadRegistry()).resolves.toMatchObject({ count: 0, plugins: [] })
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('rejects responses that omit the required verification field', async () => {
    delete process.env.DSH_PLUGINHUB_REGISTRY_URL
    const { isVerified: _omitted, ...previous } = PLUGINHUB_PLUGIN
    scriptedFetch(ok(pluginHubPage([{ ...previous, validationStatus: 'build_required', requiresBuildAuthorization: true }])))
    await expect(loadRegistry()).rejects.toThrow('validation metadata')
  })

  it('rejects malformed verification flags instead of treating strings as booleans', async () => {
    delete process.env.DSH_PLUGINHUB_REGISTRY_URL
    scriptedFetch(ok(pluginHubPage([{ ...PLUGINHUB_PLUGIN, isVerified: 'false' }])))
    await expect(loadRegistry()).rejects.toThrow('validation metadata')
  })

  it('revalidates one install candidate through the public detail endpoint', async () => {
    delete process.env.DSH_PLUGINHUB_REGISTRY_URL
    const stub = scriptedFetch(ok(pluginHubPage()))
    const plugin = await loadRegistryPlugin('https://github.com/someone/dsh-loop')
    expect(plugin).toMatchObject({ name: 'dsh-loop', category: 'development', validationStatus: 'verified' })
    expect(String(stub.mock.calls[0]?.[0])).toBe('https://dshpluginhub.com/api/marketplace/plugins/someone/dsh-loop')
  })

  it('retries once before giving up', async () => {
    const stub = scriptedFetch(new Error('fetch failed'), ok(CATALOG))
    const registry = await loadRegistry()
    expect(registry.plugins).toHaveLength(1)
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it('gives up after the second attempt rather than hammering', async () => {
    const stub = scriptedFetch(new Error('fetch failed'))
    await expect(loadRegistry()).rejects.toThrow(/fetch failed/)
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it('reports a failure instead of answering with an empty catalog', async () => {
    // The bundled snapshot used to answer here. Its absence is the feature:
    // a pluginhub showing zero plugins and a pluginhub that could not reach the
    // registry are different situations, and only one of them is the user's
    // to act on. Silence would report the wrong one.
    scriptedFetch(new Error('getaddrinfo ENOTFOUND github.com/Noob-stupid/dsh-plugin-hub'))
    await expect(loadRegistry()).rejects.toThrow(/ENOTFOUND/)
  })

  it('treats a non-2xx answer as a failure, not as a catalog', async () => {
    scriptedFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    await expect(loadRegistry()).rejects.toThrow(/HTTP 502/)
  })

  it('refuses a well-formed response with no plugins in it', async () => {
    // A CDN serving a truncated or placeholder file parses fine. Accepting
    // it would replace the catalog with nothing and call that success.
    scriptedFetch(ok({ ...CATALOG, plugins: [] }))
    await expect(loadRegistry()).rejects.toThrow(/came back empty/)
  })

  it('refuses a plugin with no usable category', async () => {
    scriptedFetch(ok({
      ...CATALOG,
      plugins: [{ ...CATALOG.plugins[0], category: [null, '', 42] }],
    }))
    await expect(loadRegistry()).rejects.toThrow(/no usable category/)
  })

  it('carries the reason, the elapsed time and the attempt count', async () => {
    // This string is the whole of what a bug report will contain: it is what
    // the pluginhub puts on screen and what the log export ships. "The
    // operation was aborted due to timeout" on its own — the exact text a
    // reporter sent us — cannot tell a slow link from a blocked one.
    scriptedFetch(new Error('The operation was aborted due to timeout'))
    await expect(loadRegistry()).rejects.toThrow(/aborted due to timeout.*\ds, 2 attempts/s)
  })
})

describe('loadRegistry download regions', () => {
  /** A fetch that answers per-URL rather than per-call. */
  function byUrl(plan: Array<[RegExp, Response | Error]>): ReturnType<typeof vi.fn> {
    const stub = vi.fn((url: unknown) => {
      const entry = plan.find(([pattern]) => pattern.test(String(url)))
      if (entry === undefined) return Promise.reject(new Error(`unexpected request: ${String(url)}`))
      const answer = entry[1]
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone())
    })
    vi.stubGlobal('fetch', stub)
    return stub
  }

  it('reads the catalog from the official domain in the global region', async () => {
    const stub = byUrl([[/dshpluginhub\.com/, ok(pluginHubPage())]])
    await loadRegistry('global')
    expect(String(stub.mock.calls[0]?.[0])).toContain('dshpluginhub.com/plugins.json')
  })

  it('uses the same canonical catalog in the china region', async () => {
    const stub = byUrl([[/dshpluginhub\.com/, ok(pluginHubPage())]])
    await loadRegistry('china')
    expect(String(stub.mock.calls[0]?.[0])).toContain('dshpluginhub.com/plugins.json')
  })

  it('retries only the canonical catalog when it fails', async () => {
    byUrl([[/./, new Error('fetch failed')]])
    await expect(loadRegistry('china')).rejects.toThrow(/2 attempts/)
  })

  it('reuses the canonical origin validator across regions', async () => {
    byUrl([[/dshpluginhub\.com/, okTagged(pluginHubPage(), 'W/"one"')]])
    await loadRegistry('global')
    const stub = byUrl([[/dshpluginhub\.com/, notModified()]])
    await loadRegistry('china', { force: true })
    const etagOf = (call: unknown[]): string | undefined =>
      ((call[1] ?? {}) as { headers?: Record<string, string> }).headers?.['if-none-match']
    expect(etagOf(stub.mock.calls[0]!)).toBe('W/"one"')
  })
})

describe('loadRegistry revalidation', () => {
  beforeEach(() => { process.env.DSH_PLUGINHUB_REGISTRY_URL = 'https://example.test/catalog.json' })
  it('asks unconditionally when it has nothing to revalidate', async () => {
    scriptedFetch(okTagged(CATALOG, 'W/"abc"'))
    await loadRegistry(undefined, { force: true })
    expect(sent[0]).toEqual({})
  })

  it('offers the validator it was given, and reuses the body on 304', async () => {
    const stub = scriptedFetch(okTagged(CATALOG, 'W/"abc"'), notModified())
    const first = await loadRegistry(undefined, { force: true })
    const second = await loadRegistry(undefined, { force: true })

    expect(sent[1]?.['if-none-match']).toBe('W/"abc"')
    expect(stub).toHaveBeenCalledTimes(2)
    expect(second).toEqual(first)
    expect(second.plugins).toHaveLength(1)
  })

  it('does NOT answer a network failure from what it last served', async () => {
    // A forced refresh must report network errors even with a cached response.
    scriptedFetch(okTagged(CATALOG, 'W/"abc"'))
    await loadRegistry(undefined, { force: true })

    scriptedFetch(new Error('getaddrinfo ENOTFOUND github.com/Noob-stupid/dsh-plugin-hub'))
    await expect(loadRegistry(undefined, { force: true })).rejects.toThrow(/ENOTFOUND/)
  })

  it('takes the new catalog, and revalidates against the new tag next time', async () => {
    scriptedFetch(okTagged(CATALOG, 'W/"old"'))
    await loadRegistry(undefined, { force: true })

    const grown = { ...CATALOG, plugins: [...CATALOG.plugins, { ...CATALOG.plugins[0]!, name: 'dsh-two' }] }
    scriptedFetch(okTagged(grown, 'W/"new"'), notModified())
    expect((await loadRegistry(undefined, { force: true })).plugins).toHaveLength(2)
    expect(sent[0]?.['if-none-match']).toBe('W/"old"')

    // A validator that stuck at the old value would make the origin resend
    // the whole catalog forever — the saving would silently stop working.
    expect((await loadRegistry(undefined, { force: true })).plugins).toHaveLength(2)
    expect(sent[1]?.['if-none-match']).toBe('W/"new"')
  })

  it('falls back to the date when the origin offers no ETag', async () => {
    scriptedFetch(okTagged(CATALOG, null, 'Tue, 18 Aug 2026 11:46:08 GMT'), notModified())
    await loadRegistry(undefined, { force: true })
    await loadRegistry(undefined, { force: true })
    expect(sent[1]).toEqual({ 'if-modified-since': 'Tue, 18 Aug 2026 11:46:08 GMT' })
  })

  it('sends only one validator, never both', async () => {
    // An origin given both must satisfy both. With a weak ETag — which is
    // exactly what this origin serves (`W/"6a844600-11111a"`) — that turns
    // a match into a full 200 and quietly undoes the saving.
    scriptedFetch(okTagged(CATALOG, 'W/"abc"', 'Tue, 18 Aug 2026 11:46:08 GMT'), notModified())
    await loadRegistry(undefined, { force: true })
    await loadRegistry(undefined, { force: true })
    expect(sent[1]).toEqual({ 'if-none-match': 'W/"abc"' })
  })

  it('treats a 304 it did not ask for as a failure', async () => {
    // Unreachable in practice, since a validator is what provokes one. It
    // would otherwise surface as a parse error on an empty body, which
    // names neither the cause nor anything the user could act on.
    scriptedFetch(notModified())
    await expect(loadRegistry(undefined, { force: true })).rejects.toThrow(/nothing to revalidate/)
  })
})

describe('catalog cache lifecycle', () => {
  beforeEach(() => { process.env.DSH_PLUGINHUB_REGISTRY_URL = 'https://example.test/catalog.json' })

  it('coalesces concurrent loads and revalidates only after expiry', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const stub = scriptedFetch(okTagged(CATALOG, '"catalog"'), notModified())
    const results = await Promise.all([loadRegistry(), loadRegistry(), loadRegistry()])
    expect(stub).toHaveBeenCalledTimes(1)
    expect(results[0]).toBe(results[1])
    now += CATALOG_TTL_MS - 1
    await loadRegistry()
    expect(stub).toHaveBeenCalledTimes(1)
    now += 1
    await Promise.all([loadRegistry(), loadRegistry()])
    expect(stub).toHaveBeenCalledTimes(2)
    expect(sent[1]).toEqual({ 'if-none-match': '"catalog"' })
    now += CATALOG_TTL_MS - 1
    await loadRegistry()
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it('does not retain failures and can retry without clearing the cache', async () => {
    const failed = scriptedFetch(new Error('offline'))
    await expect(loadRegistry()).rejects.toThrow('offline')
    expect(failed).toHaveBeenCalledTimes(2)
    const recovered = scriptedFetch(ok(CATALOG))
    await expect(loadRegistry()).resolves.toMatchObject({ count: 1 })
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('keeps different catalog sources separate', async () => {
    scriptedFetch(okTagged(CATALOG, '"first"'))
    await loadRegistry()
    process.env.DSH_PLUGINHUB_REGISTRY_URL = 'https://other.test/catalog.json'
    const second = scriptedFetch(ok(CATALOG))
    await loadRegistry()
    expect(second).toHaveBeenCalledTimes(1)
    expect(sent[0]).toEqual({})
  })

  it('invalidates an in-flight response without refilling the next cache', async () => {
    const client = createRegistryClient()
    let finish!: (response: Response) => void
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: { signal: AbortSignal }) => {
      signal = init.signal
      return new Promise<Response>(resolve => { finish = resolve })
    }))
    const pending = client.loadRegistry()
    const rejected = expect(pending).rejects.toThrow()
    client.forgetCatalog()
    expect(signal.aborted).toBe(true)
    const fresh = scriptedFetch(okTagged(CATALOG, '"new"'))
    const current = await client.loadRegistry()
    finish(okTagged({ ...CATALOG, count: 99 }, '"old"'))
    await rejected
    expect(await client.loadRegistry()).toBe(current)
    expect(fresh).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('isolates mounts and refuses loads after disposal', async () => {
    const first = createRegistryClient()
    const second = createRegistryClient()
    const stub = scriptedFetch(ok(CATALOG))
    await first.loadRegistry()
    await second.loadRegistry()
    expect(stub).toHaveBeenCalledTimes(2)
    first.dispose()
    await expect(first.loadRegistry()).rejects.toThrow('disposed')
    await expect(first.loadRegistryPlugin('https://github.com/o/p')).rejects.toThrow('disposed')
    await second.loadRegistry()
    expect(stub).toHaveBeenCalledTimes(2)
    second.dispose()
  })

  it('cancels requests when a mount is disposed', async () => {
    const client = createRegistryClient()
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: { signal: AbortSignal }) => {
      signal = init.signal
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    const pending = client.loadRegistry()
    const rejected = expect(pending).rejects.toThrow()
    client.dispose()
    expect(signal.aborted).toBe(true)
    await rejected
  })

  it('revalidates installation lookups even while the legacy catalog is cached', async () => {
    const stub = scriptedFetch(ok(CATALOG), ok({ ...CATALOG, plugins: [
      { ...CATALOG.plugins[0], url: 'https://example.com/other' },
    ] }))
    await loadRegistry()
    expect(await loadRegistryPlugin('https://example.com')).toBeUndefined()
    expect(stub).toHaveBeenCalledTimes(2)
  })

  it('always fetches the public detail endpoint for installation', async () => {
    delete process.env.DSH_PLUGINHUB_REGISTRY_URL
    const stub = scriptedFetch(ok(pluginHubPage()))
    await loadRegistry()
    await loadRegistryPlugin(PLUGINHUB_PLUGIN.url)
    await loadRegistryPlugin(PLUGINHUB_PLUGIN.url)
    expect(stub).toHaveBeenCalledTimes(3)
    expect(String(stub.mock.calls[1]?.[0])).toContain('/api/marketplace/plugins/someone/dsh-loop')
  })
})

describe('describeFetchFailure', () => {
  it('names the proxy it went through, because that is the surprising part', () => {
    // Node's global fetch ignores HTTP_PROXY entirely, so before this
    // version a machine whose only route out was a proxy failed here every
    // time while every other tool on it worked. Whether the proxy was used
    // is the first thing anyone needs to know from the message.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897'
    expect(describeFetchFailure(new Error('timeout'), 15_000))
      .toBe('timeout (15s, 2 attempts) · tried through the configured proxy http://127.0.0.1:7897')
  })

  it('says nothing about a proxy when there is none', () => {
    expect(describeFetchFailure(new Error('timeout'), 3000)).toBe('timeout (3s, 2 attempts)')
  })

  it('redacts credentials embedded in the proxy URL', () => {
    // Users paste this message into issues. A corporate proxy URL routinely
    // carries a domain login, and it would go straight into a public tracker.
    process.env.HTTPS_PROXY = 'http://alice:hunter2@proxy.corp.example:8080'
    const message = describeFetchFailure(new Error('ECONNREFUSED'), 1000)
    expect(message).toContain('//***@proxy.corp.example:8080')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('alice')
  })

  it('survives something thrown that is not an Error', () => {
    expect(describeFetchFailure('just a string', 0)).toBe('just a string (0s, 2 attempts)')
  })
})

describe('configuredProxy', () => {
  it('prefers the https proxy, which is what governs the catalog', () => {
    process.env.HTTP_PROXY = 'http://three:3'
    expect(configuredProxy()).toBe('http://three:3')
    process.env.HTTPS_PROXY = 'http://two:2'
    expect(configuredProxy()).toBe('http://two:2')
  })

  // Windows environment variables are case-INSENSITIVE: `https_proxy` and
  // `HTTPS_PROXY` are one variable there, so the second assignment below is
  // not a second variable and there is no precedence left to observe. CI
  // caught this by failing on exactly that line — the distinction is real
  // on POSIX and absent on Windows, and a test cannot assert both.
  it.skipIf(process.platform === 'win32')('lets lowercase win, as undici does', () => {
    // Not the order that reads best — the order undici actually uses
    // (`https_proxy ?? HTTPS_PROXY`), since this answer is what the failure
    // message claims was tried. Verified against a real CONNECT listener,
    // not inferred: with both set, the lowercase one receives the connect.
    process.env.HTTPS_PROXY = 'http://upper:1'
    process.env.https_proxy = 'http://lower:2'
    expect(configuredProxy()).toBe('http://lower:2')
  })

  it('falls back to the http proxy for the https catalog, as undici does', () => {
    // `this[kHttpsProxyAgent] = this[kHttpProxyAgent]` when no https proxy
    // is set. Reporting "no proxy" here would be wrong: one is in use.
    process.env.HTTP_PROXY = 'http://three:3'
    expect(configuredProxy()).toBe('http://three:3')
  })

  it('treats an empty value as unset instead of masking the http proxy', () => {
    // `export HTTPS_PROXY=` is how people turn a proxy off, and undici's
    // truthiness test falls through to HTTP_PROXY. A `??` chain does not —
    // it stops at the first DEFINED value and answers "no proxy" while one
    // is plainly configured.
    process.env.HTTPS_PROXY = ''
    process.env.HTTP_PROXY = 'http://real:1'
    expect(configuredProxy()).toBe('http://real:1')
  })

  it('treats a whitespace-only value as unset', () => {
    // Wider than undici on purpose: it would pass '   ' to `new URL()` and
    // throw out of the agent constructor, taking down a fetch that has
    // nothing wrong with it.
    process.env.HTTPS_PROXY = '   '
    expect(configuredProxy()).toBeNull()
  })

  it('trims a stray newline, which a shell heredoc leaves behind', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897\n'
    expect(configuredProxy()).toBe('http://127.0.0.1:7897')
  })

  it('uses npm_config_https_proxy when the standard variables are not set', () => {
    // The machine that reported this: its proxy was configured with
    // `npm config set proxy` (common on Windows), so it exists as
    // npm_config_* and nowhere else. Every npm-based tool works; the
    // catalog fetch still tried the direct route and timed out.
    process.env.npm_config_https_proxy = 'http://npm:1'
    expect(configuredProxy()).toBe('http://npm:1')
  })

  it('falls back to npm_config_proxy for the https catalog, as undici does', () => {
    // npm's https-proxy falls back to its plain proxy value; report the
    // proxy that is actually in use rather than "no proxy" while one is
    // plainly configured.
    process.env.npm_config_proxy = 'http://npm:2'
    expect(configuredProxy()).toBe('http://npm:2')
  })

  it('prefers a standard proxy over npm config', () => {
    // npm_config_* is a fallback source, never an override: a process
    // whose environment carries http_proxy has decided, and the pluginhub
    // must not second-guess it with the machine's npm config.
    process.env.HTTPS_PROXY = 'http://std:1'
    process.env.npm_config_https_proxy = 'http://npm:1'
    expect(configuredProxy()).toBe('http://std:1')
  })

  it('treats empty npm proxy values as unset, like the standard ones', () => {
    process.env.npm_config_https_proxy = ''
    process.env.npm_config_proxy = ''
    expect(configuredProxy()).toBeNull()
  })
})

describe('pluginHubFetch', () => {
  beforeEach(() => {
    undici.fetch.mockClear()
    undici.EnvHttpProxyAgent.mockClear()
  })

  it('hands npm-config proxies to the agent explicitly — EnvHttpProxyAgent cannot see them', async () => {
    // The trap this guards: configuredProxy() alone would make the failure
    // message claim a proxy was tried while `new EnvHttpProxyAgent()` with
    // no arguments still reads only http(s)_proxy and goes direct.
    process.env.npm_config_https_proxy = 'http://npm:1'
    await pluginHubFetch('https://catalog.example/plugins.json')
    expect(undici.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: undefined,
      httpsProxy: 'http://npm:1',
    })
    expect(undici.fetch).toHaveBeenCalledWith(
      'https://catalog.example/plugins.json',
      expect.objectContaining({ dispatcher: expect.any(Object) }),
    )
  })

  it('stays on the global fetch when there is no proxy anywhere', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    await pluginHubFetch('https://catalog.example/plugins.json')
    expect(undici.fetch).not.toHaveBeenCalled()
  })
})
