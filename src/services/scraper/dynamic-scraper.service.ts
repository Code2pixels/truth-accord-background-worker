import { chromium, type Browser } from 'playwright'
import type { RawPageData } from './scraper.interfaces.ts'

export class DynamicScraperService {
  private browser: Browser | null = null
  private readonly timeoutMs: number
  private readonly headless: boolean

  constructor() {
    this.timeoutMs = Number(process.env['SCRAPER_TIMEOUT_MS'] ?? 30_000)
    this.headless = process.env['PLAYWRIGHT_HEADLESS'] !== 'false'
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch({ headless: this.headless })
      console.log('[DynamicScraper] Playwright browser launched')
    }
    return this.browser
  }

  async fetch(url: string): Promise<RawPageData> {
    const browser = await this.getBrowser()
    const page = await browser.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs })
      const html = await page.content()
      return { html, url, usedBrowser: true }
    } finally {
      await page.close()
    }
  }

  async destroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      console.log('[DynamicScraper] Playwright browser closed')
    }
  }
}
