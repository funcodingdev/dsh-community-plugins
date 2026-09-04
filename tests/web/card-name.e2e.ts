/**
 * Render a compound catalog identity in the real host using a fixed entry
 * in the public directory protocol, independent of changing live ranks.
 */

import { chromium, type Browser, type Page } from 'playwright'
import { mockPluginHubCatalog } from './catalog.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchPluginHubScaffold, openPluginHubPage } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable())('web e2e: card header', () => {
  let s: WebScaffold, browser: Browser, page: Page
  beforeAll(async () => {
    s = await launchPluginHubScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await mockPluginHubCatalog(page)
    await openPluginHubPage(page, s)
    for (let i = 0; i < 6; i++) {
      const b = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await b.waitFor({ timeout: i === 0 ? 30_000 : 3000 }); await b.click() } catch { break }
    }
  }, 300_000)
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('shows the short plugin name inside the repository identity heading', async () => {
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByText(/社区插件|Community Plugins/).last().click()
    await page.waitForSelector('[class*="pluginGrid"] [class*="card"]', { timeout: 60_000 })
    const name = page.locator('[class*="pluginGrid"] [class*="pluginName"]').first()
    expect(await name.getAttribute('title')).toBe('OpenViking#examples/dsh-memory-plugin')
    expect((await name.innerText()).trim()).toBe('dsh-memory-plugin')
  }, 300_000)
})
