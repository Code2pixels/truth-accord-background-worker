import { chromium } from 'playwright'
import type { JobHandler } from '../types/jobs.ts'

export const browserScrapeHandler: JobHandler<'browser_scrape'> = {
  type: 'browser_scrape',
  maxAttempts: 2,
  timeoutMs: 2 * 60_000, // 2 minutes

  async run(payload) {
    const browser = await chromium.launch({ headless: true })

    try {
      const page = await browser.newPage()
      await page.goto(payload.url, { waitUntil: 'domcontentloaded' })

      if (payload.waitFor) {
        await page.waitForSelector(payload.waitFor, { timeout: 10_000 })
      }

      const content = await page.content()
      const textContent = await page.evaluate(() => document.body.innerText)

      console.log(`[browser_scrape] ${payload.url}: ${content.length} bytes HTML`)
      console.log(`[browser_scrape] text preview: ${textContent.slice(0, 300)}`)
    } finally {
      await browser.close()
    }
  },
}
