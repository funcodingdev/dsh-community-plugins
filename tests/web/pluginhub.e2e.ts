/**
 * Web e2e: the manual pre-release click-through, automated — a REAL dsh web
 * composition with the packed pluginhub installed, driven by real Chromium.
 * Mirrors the layer-3 harness convention (playwright as a library inside
 * vitest, serial, console tripwire).
 *
 * Catalog requests use a fixed public-protocol fixture; real installs have
 * their own lane. A fresh DSH_HOME boots with the testing notice and the
 * English locale — selectors tolerate both languages.
 */

import { chromium } from 'playwright'
import { mockPluginHubCatalog } from './catalog.ts'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchPluginHubScaffold, openPluginHubPage, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()

describe.skipIf(!HAS_DSH)('web e2e: PluginHub', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchPluginHubScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
    tripwire = watchConsole(page)
    await mockPluginHubCatalog(page)
    await openPluginHubPage(page, scaffold)
    // A fresh home greets with onboarding dialogs (testing notice, API-key
    // prompt, …); click through whichever appear until none are left.
    const passes = /^(Continue|继续|Configure later|稍后配置)$/
    for (let round = 0; round < 5; round++) {
      const button = page.getByRole('button', { name: passes }).first()
      try {
        await button.waitFor({ timeout: round === 0 ? 30_000 : 3000 })
        await button.click()
      } catch {
        break // no more dialogs
      }
    }
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens Settings → Community Plugins and progressively reveals the catalog', async () => {
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByRole('button', { name: /社区插件|Community Plugins/ }).click()
    await page.waitForSelector('[class*="pluginGrid"] > [class*="card"]', { timeout: 30_000 })
    const cards = page.locator('[class*="pluginGrid"] > [class*="card"]')
    const firstBatch = await cards.count()
    expect(firstBatch).toBeGreaterThanOrEqual(12)
    expect(await page.locator('[class*="pager"]').count()).toBe(0)
    expect(await page.getByRole('button', { name: /每页|Per page/ }).count()).toBe(0)

    // The app scrolls inside the settings body rather than the document. As
    // its tail reaches the same 800px preload window as dsh-plugin-hub, the
    // next 12-item batch is appended in place.
    await page.locator('[class*="body"]').filter({ has: page.locator('[class*="pluginGrid"]') }).evaluate(element => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBeGreaterThan(firstBatch)
  })

  it('shows its own version next to the heading', async () => {
    // The point of the feature is that a PHOTO of the screen carries the
    // version, so assert what is actually rendered and visible — a unit
    // test on the state would pass with the element hidden or unmounted.
    const version = page.locator('[class*="titleRow"] [class*="version"]')
    await version.waitFor({ state: 'visible', timeout: 30_000 })
    expect((await version.textContent())?.trim()).toMatch(/^v\d+\.\d+\.\d+/)
  })

  it('search and category filter the grid', async () => {
    const search = page.getByPlaceholder(/搜索插件|Search plugins/)
    const gridNames = () => page.locator('[class*="pluginGrid"] [class*="pluginName"]').allTextContents()

    const beforeSearch = await gridNames()
    await search.fill('memory')
    await expect.poll(async () => {
      const names = await gridNames()
      return names.length > 0 && JSON.stringify(names) !== JSON.stringify(beforeSearch)
    }, { timeout: 30_000 }).toBe(true)
    const searched = await gridNames()
    // A broad query can still fill the first progressive batch, so assert the
    // content changed instead of relying only on the visible count.
    expect(searched.length).toBeGreaterThanOrEqual(1)
    expect(searched).not.toEqual(beforeSearch)
    await search.fill('')
    await expect.poll(async () => {
      const names = await gridNames()
      return names.length >= 12 && JSON.stringify(names) !== JSON.stringify(searched)
    }, { timeout: 30_000 }).toBe(true)

    const allNames = await gridNames()
    const chips = page.locator('[class*="catsWrap"] [data-chip="1"]')
    await chips.nth(1).click()
    await expect.poll(async () => {
      const names = await gridNames()
      return names.length > 0 && JSON.stringify(names) !== JSON.stringify(allNames)
    }, { timeout: 30_000 }).toBe(true)
    const categorized = await gridNames()
    expect(categorized.length).toBeGreaterThanOrEqual(1)
    expect(categorized).not.toEqual(allNames)
    await chips.nth(0).click() // back to All
    // Clearing the filter restores the first progressive batch, so a chip
    // that silently stuck would not read as a pass.
    await expect.poll(gridNames, { timeout: 30_000 }).toEqual(allNames)
  })

  it('never lists the pluginhub itself in the Installed tab — it manages itself from its own settings card', async () => {
    await page.getByRole('button', { name: /已安装|Installed/ }).click()
    await page.waitForTimeout(1000)
    expect(await page.locator('[class*="irow"]', { hasText: 'dsh-pluginhub' }).count()).toBe(0)
  })

  it('the install dialog opens and cancels cleanly', async () => {
    // Independent of the previous test's final tab.
    await page.getByRole('button', { name: /^(发现|Discover)$/ }).click()
    await page.waitForSelector('[class*="pluginGrid"] [class*="card"]', { timeout: 15_000 })
    await page.getByRole('button', { name: /^(安装|Install)$/ }).first().click()
    const cancel = page.getByRole('button', { name: /^(取消|Cancel)$/ }).first()
    await cancel.waitFor({ timeout: 5000 })
    await cancel.click()
  })

  it('no console errors across the whole journey', () => {
    // GitHub avatars may 404 offline; resource errors surface as console
    // errors with net:: markers — tolerate only those.
    const meaningful = tripwire.errors().filter(text => !/net::|Failed to load resource/.test(text))
    expect(meaningful).toEqual([])
  })
})
