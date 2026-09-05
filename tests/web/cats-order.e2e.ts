/** Real-host check for wrapping category chips and stable selection order. */
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { dshAvailable, launchPluginHubScaffold, openPluginHubPage } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'
import { mockPluginHubCatalog } from './catalog.ts'

describe.skipIf(!dshAvailable())('web e2e: category chip order stays put', () => {
  let s: WebScaffold, browser: any, page: any
  beforeAll(async () => {
    s = await launchPluginHubScaffold()
    browser = await chromium.launch()
  }, 300_000)
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await mockPluginHubCatalog(page)
    await openPluginHubPage(page, s)
    for (let i = 0; i < 6; i++) {
      const b = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await b.waitFor({ timeout: i === 0 ? 30_000 : 3000 }); await b.click() } catch { break }
    }
  }, 300_000)
  afterEach(async () => { await page?.close() })
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('shows every category in multiple rows without clipping or reordering on selection', async () => {
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByRole('button', { name: /社区插件|Community Plugins/ }).click()
    await page.waitForSelector('[class*="pluginGrid"] [class*="card"]', { timeout: 60_000 })
    const wrap = page.locator('[class*="catsWrap"]')
    const chips = wrap.locator('[data-chip="1"]')
    expect(await chips.count()).toBeGreaterThan(2)
    const filters = page.locator('[class*="discoverFilters"]')
    for (const viewport of [
      { width: 1200, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.evaluate(async () => {
        const win = globalThis as any
        await win.document.fonts.ready
        // Deliver resize observers and their React update before sampling.
        await new Promise<void>(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)))
      })
      // ResizeObserver can fold chips between separate Playwright reads.
      // Take every rectangle in one browser task, then retry the complete
      // layout contract while the resize/font-driven reflow settles.
      await expect.poll(async () => {
        const layout = await page.evaluate(() => {
          const doc = (globalThis as any).document
          const wrap = doc.querySelector('[class*="catsWrap"]')
          const filters = doc.querySelector('[class*="discoverFilters"]')
          const rect = (element: any) => {
            const { x, y, width, height } = element.getBoundingClientRect()
            return { x, y, width, height }
          }
          return {
            width: wrap.clientWidth, contentWidth: wrap.scrollWidth,
            rows: new Set(Array.from(wrap.children, (child: any) => child.getBoundingClientRect().top)).size,
            wrap: rect(wrap), filters: rect(filters),
            verification: rect(filters.querySelector('label')),
            sort: rect(filters.querySelector('button')),
            chips: Array.from(wrap.querySelectorAll('[data-chip="1"]'), rect),
          }
        })
        if (viewport.width <= 420) expect(layout.rows).toBeGreaterThan(1)
        expect(layout.contentWidth).toBeLessThanOrEqual(layout.width)
        const { wrap: wrapBox, filters: filterBox, verification: verificationBox, sort: sortBox } = layout
        if (viewport.width > 420) {
          expect(filterBox.x).toBeGreaterThanOrEqual(wrapBox.x + wrapBox.width)
          expect(Math.abs(filterBox.y - wrapBox.y)).toBeLessThan(2)
        } else {
          expect(filterBox.y).toBeGreaterThanOrEqual(wrapBox.y + wrapBox.height)
        }
        expect(verificationBox.x + verificationBox.width).toBeLessThan(sortBox.x)
        expect(Math.abs(verificationBox.y + verificationBox.height / 2 - sortBox.y - sortBox.height / 2)).toBeLessThan(2)
        const chipWidths = []
        for (const box of layout.chips) {
          expect(box.x).toBeGreaterThanOrEqual(wrapBox.x)
          expect(box.x + box.width).toBeLessThanOrEqual(wrapBox.x + wrapBox.width)
          chipWidths.push(Math.round(box.width))
        }
        expect(new Set(chipWidths).size).toBeGreaterThan(1)
        return true
      }, { timeout: 10_000 }).toBe(true)
    }
    // Narrow viewports may fold the final category into overflow. Compare
    // the complete order only after expanding, not against a desktop snapshot
    // of a different visible subset.
    // The toggle can appear after a resize. Re-check the collapsed action
    // until the full fixture is visible; a one-shot count() can miss it.
    await expect.poll(async () => {
      const expand = wrap.locator('button[aria-expanded="false"]')
      if (await expand.isVisible()) await expand.click({ timeout: 1000 })
      return (await chips.allTextContents()).slice(1)
    }, { timeout: 10_000 }).toEqual([
      'Interface', 'Developer tools', 'Automation', 'Knowledge & search', 'Agent capability',
    ])
    const before = await chips.allTextContents()
    const filterBefore = await filters.boundingBox()
    await chips.last().click()
    await expect.poll(() => chips.last().getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => page.locator('[class*="pluginGrid"] > *').count()).toBe(7)
    await expect.poll(async () => (await chips.allTextContents()).slice(1)).toEqual(before.slice(1))
    expect(await filters.boundingBox()).toEqual(filterBefore)
  }, 300_000)

  it('expands and collapses overflow without clearing selection or exposing hidden controls', async () => {
    const extraCategories = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `extra-${index}`, { zh: `扩展分类 ${index + 1}`, en: `Extra category ${index + 1}` },
    ]))
    await mockPluginHubCatalog(page, extraCategories)
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByRole('button', { name: /社区插件|Community Plugins/ }).click()
    await page.waitForSelector('[class*="pluginGrid"] [class*="card"]', { timeout: 60_000 })
    const wrap = page.locator('[class*="catsWrap"]')
    const chips = wrap.locator('[data-chip="1"]')
    const toggle = wrap.locator('button[aria-expanded]')
    const rowCount = () => wrap.evaluate((element: { children: ArrayLike<{ getBoundingClientRect(): { top: number } }> }) =>
      new Set(Array.from(element.children, child => child.getBoundingClientRect().top)).size)
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(rowCount).toBe(2)
      const collapsedCount = await chips.count()
      expect(collapsedCount).toBeLessThan(16)
      expect(await page.getByRole('button', { name: /^(扩展分类 10|Extra category 10)$/ }).count()).toBe(0)
      await toggle.focus()
      await toggle.press('Enter')
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
      expect(await chips.count()).toBe(16)
      expect(await rowCount()).toBeGreaterThan(2)
      const labels = (await chips.allTextContents()).slice(1)
      await chips.last().click()
      await expect.poll(() => chips.last().getAttribute('aria-pressed')).toBe('true')
      await toggle.click()
      await expect.poll(rowCount).toBe(2)
      expect(await chips.count()).toBeLessThan(16)
      await toggle.click()
      expect(await chips.last().getAttribute('aria-pressed')).toBe('true')
      expect((await chips.allTextContents()).slice(1)).toEqual(labels)
      await toggle.click()
    }
  })
})
