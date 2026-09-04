/**
 * Client-side installed-state matching (#15): one identity algorithm shared
 * by the discover badge and the installed tab. Scenarios
 * contributed by @yanshuai2002's matching spec. Each case is built so only
 * ONE identity path can produce the match — a broken path cannot hide
 * behind a working fallback.
 */

import { describe, expect, it } from 'vitest'
import {
  entryForDep, extractReadmeImageCandidates, extractReadmeImages, formatCount, installedForCatalog, isInstalled, looksTerminal, pluginHubLanguage, pluginHubText, matchInstalledName, pluginCategories, previewDimensionScore, safeScreenshots, humanOutput} from '../src/client/pluginhub-data.ts'
import type { RegistryPlugin } from '../src/client/pluginhub-data.ts'

function plugin(partial: Partial<RegistryPlugin>): RegistryPlugin {
  return { name: 'x', owner: 'o', url: 'https://github.com/o/x', category: 'tool', ...partial }
}

describe('pluginhub language', () => {
  it('uses Chinese only for Chinese host settings and English for everything else', () => {
    expect(pluginHubLanguage('zh')).toBe('zh')
    expect(pluginHubLanguage('zh-CN')).toBe('zh')
    expect(pluginHubLanguage('zh_Hans')).toBe('zh')
    expect(pluginHubLanguage('en')).toBe('en')
    expect(pluginHubLanguage('ja')).toBe('en')
    expect(pluginHubLanguage(undefined)).toBe('en')
  })

  it('selects the matching protocol copy without falling back to Chinese in English mode', () => {
    const text = { zh: '中文', en: 'English' }
    expect(pluginHubText(text, 'zh')).toBe('中文')
    expect(pluginHubText(text, 'en')).toBe('English')
    expect(pluginHubText({ zh: '仅中文' }, 'en')).toBe('')
    expect(pluginHubText({ en: 'English only' }, 'zh')).toBe('English only')
  })
})

describe('looksTerminal', () => {
  it('does not label a web plugin as terminal-only when the description says a CLI is not required', () => {
    expect(looksTerminal(plugin({
      name: 'dsh-codex-subscription',
      description: { en: 'ChatGPT OAuth provider for DSH; no API key or Codex CLI required.' },
    }), 'en')).toBe(false)

    expect(looksTerminal(plugin({
      name: 'dsh-codex-subscription',
      description: { zh: '在 DSH 网页版中使用 Codex；无需 API Key 或 Codex CLI。' },
    }), 'zh')).toBe(false)
  })

  it('still warns for plugins that positively target a terminal surface', () => {
    expect(looksTerminal(plugin({ name: 'dsh-tui' }), 'en')).toBe(true)
    expect(looksTerminal(plugin({ description: { zh: '为 DSH 提供命令行界面。' } }), 'zh')).toBe(true)
  })
})

describe('installedForCatalog', () => {
  it('adds Bundle presence without replacing dependency specs', () => {
    expect(installedForCatalog(
      { managed: '^2.0.0', shared: 'workspace:*' },
      ['host-provided', 'shared'],
    )).toEqual({
      'host-provided': '*',
      shared: 'workspace:*',
      managed: '^2.0.0',
    })
  })
})

describe('matchInstalledName / isInstalled', () => {
  it('matches through each identity path exclusively; never by prefix', () => {
    // NAME path (scoped, registry npm field unset; url points elsewhere).
    expect(matchInstalledName(
      plugin({ name: '@scope/plug', url: 'https://github.com/other/elsewhere' }),
      { '@scope/plug': '^1.0.0' },
    )).toBe('@scope/plug')

    // NAME path, case-normalized (no repo/npm fallback available).
    expect(matchInstalledName(
      plugin({ name: 'Dsh-Loop', url: 'https://github.com/other/elsewhere' }),
      { 'dsh-loop': '^1.0.0' },
    )).toBe('dsh-loop')

    // REPO path, case-normalized (key and name share nothing; URL vs github: spec).
    expect(matchInstalledName(
      plugin({ name: 'entry-name', url: 'https://github.com/VLLN/Dsh-Navbar' }),
      { 'some-key': 'github:vlln/dsh-navbar#main' },
    )).toBe('some-key')

    // REPO path reached from a scoped dependency KEY (@owner/name → owner/name).
    expect(matchInstalledName(
      plugin({ name: 'pretty-name', url: 'https://github.com/scope/plug' }),
      { '@scope/plug': '^1.0.0' },
    )).toBe('@scope/plug')

    // REPO path extracted from a monorepo /tree/ url.
    expect(matchInstalledName(
      plugin({ name: 'theme-x', url: 'https://github.com/o/collection/tree/main/packages/theme-x' }),
      { 'installed-key': 'github:o/collection#path:/packages/theme-x' },
    )).toBe('installed-key')

    // Monorepo siblings never cross-match: same repo, different subpath.
    expect(isInstalled(
      plugin({ name: 'mono#plug-b', url: 'https://github.com/m/mono/tree/main/packages/plug-b' }),
      { 'plug-a': 'github:m/mono#path:/packages/plug-a' },
    )).toBe(false)

    // Identities are exact — a mere name prefix must NOT match.
    expect(isInstalled(
      plugin({ name: 'dsh-loop', url: 'https://github.com/o/dsh-loop' }),
      { 'dsh-loop-extended': '^1.0.0' },
    )).toBe(false)
  })

  it('repo evidence beats a name coincidence — same-named entries from different repos never cross-match (#66)', () => {
    // The curated registry really lists both: two distinct dsh-usage-stats.
    const installed = { 'dsh-usage-stats': 'github:Make0209/dsh-usage-stats' }
    expect(matchInstalledName(
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Make0209/dsh-usage-stats' }), installed,
    )).toBe('dsh-usage-stats')
    // The OTHER repo's card must not read as installed, despite the equal name.
    expect(matchInstalledName(
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Ychris12138/dsh-usage-stats' }), installed,
    )).toBeNull()
    // …and the installed dep resolves back to the repo it came from.
    const plugins = [
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Ychris12138/dsh-usage-stats' }),
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Make0209/dsh-usage-stats' }),
    ]
    expect(entryForDep(plugins, 'dsh-usage-stats', 'github:make0209/dsh-usage-stats')?.url)
      .toBe('https://github.com/Make0209/dsh-usage-stats')
    // An npm-installed dep carries no repo evidence — the name path stands (#15).
    expect(matchInstalledName(
      plugin({ name: 'dsh-usage-stats', url: 'https://github.com/Ychris12138/dsh-usage-stats' }),
      { 'dsh-usage-stats': '^1.0.0' },
    )).toBe('dsh-usage-stats')
  })

  it('uses local repo evidence to disambiguate same-named link installs (#141)', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/pro/dsh/dsh-vision-bridge' }
    const repoIdentities = { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] }
    const plugins = [
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/GXX182/dsh-vision-bridge' }),
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/ximengxiaolan/dsh-vision-bridge' }),
    ]

    expect(matchInstalledName(
      plugins[0]!,
      installed,
      repoIdentities,
    )).toBe('dsh-vision-bridge')
    expect(matchInstalledName(
      plugins[1]!,
      installed,
      repoIdentities,
    )).toBeNull()

    // With no strong identity the client admits ambiguity instead of marking
    // every same-named catalog entry as installed.
    expect(matchInstalledName(plugins[0]!, installed, {}, plugins)).toBeNull()
    expect(matchInstalledName(plugins[1]!, installed, {}, plugins)).toBeNull()
    expect(entryForDep(plugins, 'dsh-vision-bridge', installed['dsh-vision-bridge']!)).toBeUndefined()
  })

  it('uses a weak Git-origin hint only among duplicate candidates', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/src/dsh-vision-bridge' }
    const plugins = [
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/gxx182/dsh-vision-bridge' }),
      plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/other/dsh-vision-bridge' }),
    ]
    const hints = { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] }

    expect(matchInstalledName(plugins[0]!, installed, {}, plugins, hints)).toBe('dsh-vision-bridge')
    expect(matchInstalledName(plugins[1]!, installed, {}, plugins, hints)).toBeNull()
    expect(entryForDep(plugins, 'dsh-vision-bridge', installed['dsh-vision-bridge']!, [], hints['dsh-vision-bridge'])).toBe(plugins[0])
  })

  it('keeps a unique loose name match when no repository identity exists', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/src/dsh-vision-bridge' }
    const only = plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/other/dsh-vision-bridge' })

    expect(matchInstalledName(only, installed, {}, [only])).toBe('dsh-vision-bridge')
    expect(entryForDep([only], 'dsh-vision-bridge', installed['dsh-vision-bridge']!)).toBe(only)
    expect(isInstalled(only, installed, {}, [only])).toBe(true)
  })

  it('keeps the unique loose name match when a weak hint disagrees', () => {
    const installed = { 'dsh-vision-bridge': 'link:D:/src/dsh-vision-bridge' }
    const only = plugin({ name: 'dsh-vision-bridge', url: 'https://github.com/other/dsh-vision-bridge' })
    const hints = { 'dsh-vision-bridge': ['gxx182/dsh-vision-bridge'] }

    expect(matchInstalledName(only, installed, {}, [only], hints)).toBe('dsh-vision-bridge')
    expect(entryForDep([only], 'dsh-vision-bridge', installed['dsh-vision-bridge']!, [], hints['dsh-vision-bridge'])).toBe(only)
  })

  it('rejects malformed repository identities from local package metadata', () => {
    const name = 'dsh-vision-bridge'
    const installed = { [name]: 'link:D:/src/dsh-vision-bridge' }
    const plugins = [
      plugin({ name, url: 'https://example.invalid/first' }),
      plugin({ name, url: 'https://example.invalid/second' }),
    ]
    const repoIdentities = { [name]: ['not a repo id', 'a/b/c/d'] }

    expect(matchInstalledName(plugins[0]!, installed, repoIdentities, plugins)).toBeNull()
    expect(entryForDep(plugins, name, installed[name]!, repoIdentities[name])).toBeUndefined()
  })

  it('rejects repository identities with traversal segments', () => {
    const name = 'dsh-vision-bridge'
    const installed = { [name]: 'link:D:/src/dsh-vision-bridge' }
    const plugins = [
      plugin({ name, url: 'https://example.invalid/first' }),
      plugin({ name, url: 'https://example.invalid/second' }),
    ]
    const repoIdentities = { [name]: ['owner/repo#path:/../../x'] }

    expect(matchInstalledName(plugins[0]!, installed, repoIdentities, plugins)).toBeNull()
    expect(entryForDep(plugins, name, installed[name]!, repoIdentities[name])).toBeUndefined()
  })

  it('matches local monorepo evidence the same way as a github:#path spec', () => {
    const root = plugin({ name: 'collection', url: 'https://github.com/o/collection' })
    const exact = plugin({
      name: 'plugin-a',
      url: 'https://github.com/o/collection/tree/main/packages/plugin-a',
    })
    const sibling = plugin({
      name: 'plugin-b',
      url: 'https://github.com/o/collection/tree/main/packages/plugin-b',
    })
    const installed = { 'plugin-a': 'link:D:/src/collection/packages/plugin-a' }
    const repoIdentities = {
      'plugin-a': ['o/collection', 'o/collection#path:/packages/plugin-a'],
    }

    expect(matchInstalledName(root, installed, repoIdentities)).toBe('plugin-a')
    expect(matchInstalledName(exact, installed, repoIdentities)).toBe('plugin-a')
    expect(matchInstalledName(sibling, installed, repoIdentities)).toBeNull()

    const sha = 'b0e6c57ebeeb4796017864f5cd5c66e6ba0899ec'
    const pinned = { 'plugin-a': `github:o/collection#${sha}&path:/packages/plugin-a` }
    expect(matchInstalledName(root, pinned)).toBe('plugin-a')
    expect(matchInstalledName(exact, pinned)).toBe('plugin-a')
    expect(matchInstalledName(sibling, pinned)).toBeNull()
  })
})

describe('entryForDep', () => {
  it('resolves an installed dependency back to its registry entry (npm and github-spec paths)', () => {
    const plugins = [
      plugin({ name: 'a', url: 'https://github.com/o/a' }),
      plugin({ name: 'b', url: 'https://github.com/o/b', npm: 'b-npm' }),
    ]
    expect(entryForDep(plugins, 'b-npm', '^1.0.0')?.name).toBe('b')
    expect(entryForDep(plugins, 'anything', 'github:o/a#main')?.name).toBe('a')
    expect(entryForDep(plugins, 'unknown', '^1.0.0')).toBeUndefined()
  })
})

describe('plugin categories', () => {
  it('deduplicates category arrays and accepts legacy single categories', () => {
    expect(pluginCategories(plugin({ category: ['tool', 'skill', 'tool'] }))).toEqual(['tool', 'skill'])
    expect(pluginCategories(plugin({ category: 'tool' }))).toEqual(['tool'])
  })
})

describe('screenshots (#61)', () => {
  it('safeScreenshots keeps only https GitHub-hosted raster images, deduped and capped', () => {
    expect(safeScreenshots([
      'https://raw.githubusercontent.com/o/r/main/a.png',
      'https://raw.githubusercontent.com/o/r/main/a.png', // dupe
      'https://user-images.githubusercontent.com/1/shot.gif',
      'https://evil.example/track.png',                    // host not allowlisted
      'http://raw.githubusercontent.com/o/r/main/b.png',   // not https
      'https://raw.githubusercontent.com/o/r/main/logo.svg', // svg = logo/badge noise
      42,
    ])).toEqual([
      'https://raw.githubusercontent.com/o/r/main/a.png',
      'https://user-images.githubusercontent.com/1/shot.gif',
    ])
    expect(safeScreenshots(undefined)).toEqual([])
    // capped at 6
    const many = Array.from({ length: 9 }, (_, i) => `https://raw.githubusercontent.com/o/r/main/s${i}.png`)
    expect(safeScreenshots(many)).toHaveLength(6)
  })

  it('extractReadmeImages ranks screenshot evidence ahead of title logos and keeps scanning past six images', () => {
    const md = [
      '# my-plugin',
      '[![npm](https://img.shields.io/npm/v/x)](https://npmjs.com/x)', // badge → host filtered
      ...Array.from({ length: 7 }, (_, i) => `![project logo](assets/logo-${i}.png)`),
      '## Screenshots / 截图',
      '<img src="./assets/settings-fragment.png" alt="settings screenshot" width="420" height="900">',
      '![Full theme preview](/docs/full-preview.png "Showcase")',
      '![Conversation screen](https://user-images.githubusercontent.com/1/conversation.png)',
    ].join('\n')
    expect(extractReadmeImages(md, 'o', 'r', null)).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/docs/full-preview.png',
      'https://user-images.githubusercontent.com/1/conversation.png',
    ])
    expect(extractReadmeImageCandidates(md, 'o', 'r', null).every(candidate => !candidate.src.includes('logo'))).toBe(true)
    // Monorepo subpath README: relative paths resolve against the subdir.
    expect(extractReadmeImages('![s](shot.png)', 'o', 'r', 'packages/plug-a')).toEqual([
      'https://raw.githubusercontent.com/o/r/HEAD/packages/plug-a/shot.png',
    ])
    expect(extractReadmeImages('no images here', 'o', 'r', null)).toEqual([])
  })

  it('preview dimensions accept complete landscape screenshots and reject fragments', () => {
    expect(previewDimensionScore(427, 240)).not.toBeNull()
    expect(previewDimensionScore(320, 240)).not.toBeNull()
    expect(previewDimensionScore(180, 240)).toBeNull()
    expect(previewDimensionScore(240, 240)).toBeNull()
    expect(previewDimensionScore(640, 150)).toBeNull()
    expect(previewDimensionScore(260, 146)).toBeNull()
  })
})

/**
 * A failed install's user-visible text. pnpm's ndjson reporter emits one
 * JSON object per progress tick, so a large `github:` download produces
 * thousands; when the failure matches no known signature there is no
 * diagnosis to show and the UI falls back to the tail of the output —
 * handing the user 600 characters of `{"name":"pnpm:fetching-progress"}`
 * at the one moment they need a sentence (#148, same shape behind #161).
 */
describe('humanOutput', () => {
  it('drops pnpm progress chatter', () => {
    const raw = [
      'Progress: resolved 1, reused 0',
      '{"time":1786951840209,"name":"pnpm:fetching-progress","downloaded":45573678,"status":"in_progress"}',
      '{"time":1786951840710,"name":"pnpm:fetching-progress","downloaded":45596968,"status":"in_progress"}',
      'ERR_PNPM_SOMETHING  the thing that actually went wrong',
    ].join('\n')
    expect(humanOutput(raw)).toBe('Progress: resolved 1, reused 0\nERR_PNPM_SOMETHING  the thing that actually went wrong')
  })

  it('keeps JSON that carries a diagnosis', () => {
    // An unrecognized failure is exactly when discarding information costs
    // the most, so only pure progress objects are dropped.
    const raw = [
      '{"name":"pnpm:fetching-progress","downloaded":1}',
      '{"name":"pnpm:error","err":{"code":"ERR_PNPM_FETCH_404"}}',
      '{"level":"error","message":"tarball not found"}',
    ].join('\n')
    const out = humanOutput(raw)
    expect(out).toContain('ERR_PNPM_FETCH_404')
    expect(out).toContain('tarball not found')
    expect(out).not.toContain('fetching-progress')
  })

  it('leaves ordinary output and malformed lines alone', () => {
    expect(humanOutput('plain error\n{not json\n')).toBe('plain error\n{not json')
    expect(humanOutput('')).toBe('')
  })
})

describe('formatCount', () => {
  it('shows the exact number under 1000, where precision is the point', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
  })

  it('abbreviates 1000 and above to one decimal, dropping a trailing .0', () => {
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(1086)).toBe('1.1k')
    expect(formatCount(11862)).toBe('11.9k')
    expect(formatCount(20006)).toBe('20k')
    expect(formatCount(999_999)).toBe('1000k')
  })
})

describe('installed-state matching stays cheap as the catalog grows (#262)', () => {
  // "插件页面非常卡". A profile from the reporter put looseMatchCount at 2.9
  // seconds — 28% of the whole trace. It answers "how many catalog entries
  // could this installed dependency be?", which depends only on the catalog
  // and the name, yet it ran once per installed dependency PER RENDERED
  // CARD, each time scanning every entry. cards × installed × catalog, on
  // every render.
  const catalog = (n: number): RegistryPlugin[] =>
    Array.from({ length: n }, (_, i) => plugin({
      name: `pkg-${i}`, npm: `pkg-${i}`, url: `https://github.com/o${i}/pkg-${i}`,
    }))

  it('makes a RE-render cheap, which is what scrolling actually costs', () => {
    // The property to pin is not "fast" (a wall-clock budget would flake on
    // a slow box) but "the catalog is scanned once, not once per render".
    // Scrolling re-renders the list repeatedly; before the memo every one of
    // those repeated the full cards × installed × catalog scan, so a second
    // render cost exactly as much as the first.
    //
    // Sized and sampled for a noisy CI machine: a big catalog so the first
    // render's work dwarfs fixed overhead, and the FASTEST of several warm
    // renders, so one unlucky GC pause cannot decide the verdict. A first
    // attempt at 2000 entries and a single sample measured 50x locally and
    // 4.7x on CI — the signal was real, the sampling was not.
    const plugins = catalog(8000)
    const installed: Record<string, string> = {}
    for (let i = 0; i < 24; i++) installed[`pkg-${i}`] = '^1.0.0'
    const render = (): number => {
      const t0 = performance.now()
      for (const p of plugins.slice(0, 48)) isInstalled(p, installed, {}, plugins, {})
      return performance.now() - t0
    }
    const first = render()
    let warm = Infinity
    for (let i = 0; i < 5; i++) warm = Math.min(warm, render())
    // Real ratio is in the hundreds; anything under 10x means the
    // per-render catalog scan is back.
    expect(first / Math.max(warm, 0.001)).toBeGreaterThan(10)
  })

  it('still answers identically for an ambiguous name, memo or not', () => {
    // The memo must not change WHAT is matched — two entries share the
    // `shared` identity, so the ambiguity guard must still refuse to guess.
    const plugins = [
      plugin({ name: 'shared', npm: 'shared', url: 'https://github.com/a/shared' }),
      plugin({ name: 'shared-too', npm: 'shared', url: 'https://github.com/b/shared-too' }),
    ]
    const installed = { shared: '^1.0.0' }
    // Repeated calls exercise the cached path; the verdict must not drift.
    for (let i = 0; i < 3; i++) {
      expect(isInstalled(plugins[0]!, installed, {}, plugins, {})).toBe(false)
      expect(isInstalled(plugins[1]!, installed, {}, plugins, {})).toBe(false)
    }
    // ...and a repo hint still resolves it, from the cached path too.
    expect(isInstalled(plugins[0]!, installed, {}, plugins, { shared: ['a/shared'] })).toBe(true)
  })

  it('does not leak a count between two different catalogs', () => {
    // Keyed on the array identity: a refetched catalog is a new array, so a
    // stale count from the previous one must never be reused.
    const before = [plugin({ name: 'solo', npm: 'solo', url: 'https://github.com/a/solo' })]
    const installed = { solo: '^1.0.0' }
    expect(isInstalled(before[0]!, installed, {}, before, {})).toBe(true)
    const after = [
      plugin({ name: 'solo', npm: 'solo', url: 'https://github.com/a/solo' }),
      plugin({ name: 'solo-two', npm: 'solo', url: 'https://github.com/b/solo-two' }),
    ]
    // Now ambiguous in the NEW catalog — the old count of 1 must not survive.
    expect(isInstalled(after[0]!, installed, {}, after, {})).toBe(false)
  })
})
