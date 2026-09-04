import type { Page } from 'playwright'

const categories = {
  all: { zh: '全部', en: 'All' },
  interface: { zh: '界面扩展', en: 'Interface' },
  development: { zh: '开发工具', en: 'Developer tools' },
  automation: { zh: '自动化', en: 'Automation' },
  knowledge: { zh: '知识与检索', en: 'Knowledge & search' },
  agent: { zh: 'Agent 能力', en: 'Agent capability' },
}
const sorts = {
  recommended: { zh: '推荐', en: 'Recommended' },
  updated: { zh: '最近更新', en: 'Recently updated' },
  stars: { zh: '最多星标', en: 'Most stars' },
}
const plugins = Array.from({ length: 36 }, (_, index) => ({
  name: index === 0 ? 'OpenViking#examples/dsh-memory-plugin' : `dsh-${index % 2 === 0 ? 'memory' : 'tools'}-${index}`,
  owner: 'example',
  url: `https://github.com/example/dsh-fixture-${index}`,
  category: Object.keys(categories)[1 + index % 5]!,
  description: { zh: `插件 ${index}`, en: `Plugin ${index}` },
  stars: 36 - index,
  install: `dsh plugin --profile web add github:example/dsh-fixture-${index}`,
  added: '2026-01-01',
  updatedAt: '2026-01-01T00:00:00Z',
  isVerified: true,
  installable: true,
  validationStatus: 'verified',
  validationReason: '',
  requiresBuildAuthorization: false,
}))

/** Keep real-host UI checks independent of directory outages and changing ranks. */
export async function mockPluginHubCatalog(page: Page, extraCategories: Record<string, { zh: string; en: string }> = {}): Promise<void> {
  await page.route('https://dshpluginhub.com/plugins.json?*', async route => {
    const params = new URL(route.request().url()).searchParams
    const category = params.get('category') ?? 'all'
    const query = (params.get('q') ?? '').toLowerCase()
    const currentPage = Number(params.get('page') ?? 1)
    const pageSize = Number(params.get('pageSize') ?? 12)
    const filtered = plugins.filter(plugin => (category === 'all' || plugin.category === category)
      && `${plugin.name} ${plugin.description.en}`.toLowerCase().includes(query))
    const totalPages = Math.ceil(filtered.length / pageSize)
    const hasMore = currentPage < totalPages
    await route.fulfill({ json: {
      name: 'dsh-plugin-hub',
      url: 'https://dshpluginhub.com/',
      source: 'test fixture',
      updated: '2026-01-01T00:00:00Z',
      count: filtered.length,
      categories: { ...categories, ...extraCategories },
      sorts,
      pagination: {
        page: currentPage, pageSize, total: filtered.length, totalPages,
        hasMore, nextPage: hasMore ? currentPage + 1 : null,
      },
      plugins: filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    } })
  })
}
