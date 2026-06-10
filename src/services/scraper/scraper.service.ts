import { StaticScraperService } from './static-scraper.service.ts'
import { DynamicScraperService } from './dynamic-scraper.service.ts'
import type { ScrapedArticle, ScraperOptions, PaywallSignals } from './scraper.interfaces.ts'

const PAYWALL_KEYWORDS = [
  'subscribe to read', 'subscription required', 'premium content',
  'sign in to read', 'this article is for subscribers',
  'unlimited access', 'create a free account', 'paywall', 'already a subscriber',
]

const WORD_COUNT_PAYWALL_THRESHOLD = 150

export class ScraperService {
  constructor(
    private readonly staticScraper: StaticScraperService,
    private readonly dynamicScraper: DynamicScraperService,
  ) {}

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedArticle> {
    console.log(`[Scraper] Scraping: ${url}`)
    let raw = await this.staticScraper.fetch(url)

    const needsBrowser =
      options.forceDynamic === true ||
      (!options.forceStatic && this.staticScraper.requiresBrowser(raw.html))

    if (needsBrowser) {
      raw = await this.dynamicScraper.fetch(url)
    }

    const extracted = this.staticScraper.extractArticleData(raw.html)
    const paywallSignals = this.detectPaywall(raw.html, extracted.wordCount)
    const paywallDetected = Object.values(paywallSignals).some(Boolean)

    return { url, ...extracted, isArchived: false, snapshotTimestamp: null, paywallDetected }
  }

  detectPaywall(html: string, wordCount: number | null): PaywallSignals {
    const htmlLower = html.toLowerCase()
    return {
      hasPaywallKeyword: PAYWALL_KEYWORDS.some((kw) => htmlLower.includes(kw)),
      hasSubscribeModal:
        (htmlLower.includes('class="modal"') || htmlLower.includes("class='modal'")) &&
        (htmlLower.includes('subscribe') || htmlLower.includes('sign in')),
      isContentEmpty: html.trim().length === 0,
      wordCountBelowThreshold: wordCount !== null && wordCount < WORD_COUNT_PAYWALL_THRESHOLD,
    }
  }
}
