import { chromium } from 'playwright'
import { insertArticle } from '../lib/articles.ts'
import type { ArticleInsert } from '../lib/articles.ts'
import type { JobHandler } from '../types/jobs.ts'

export const browserScrapeHandler: JobHandler<'browser_scrape'> = {
  type: 'browser_scrape',
  maxAttempts: 2,
  timeoutMs: 2 * 60_000,

  async run(payload) {
    const browser = await chromium.launch({ headless: true })

    try {
      const page = await browser.newPage()
      await page.goto(payload.url, { waitUntil: 'domcontentloaded' })

      if (payload.waitFor) {
        await page.waitForSelector(payload.waitFor, { timeout: 10_000 })
      }

      const meta = await page.evaluate((): Omit<ArticleInsert, 'url'> => {
        const getMeta = (name: string): string =>
          (document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null)?.content?.trim() ?? ''

        const origin = window.location.origin
        const hostname = window.location.hostname

        return {
          title: document.title.trim(),
          summary: getMeta('description'),
          authored_by: getMeta('author') || hostname,
          source: hostname,
          source_url: origin,
        }
      })

      const id = await insertArticle({ url: payload.url, ...meta })
      console.log(`[browser_scrape] inserted article ${id} for ${payload.url}`)
    } finally {
      await browser.close()
    }
  },
}
