import * as cheerio from 'cheerio'
import type { RawPageData, ExtractedArticleData } from './scraper.interfaces.ts'

export class StaticScraperService {
  private readonly timeoutMs: number

  constructor() {
    this.timeoutMs = Number(process.env['SCRAPER_TIMEOUT_MS'] ?? 30_000)
  }

  async fetch(url: string): Promise<RawPageData> {
    const res = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthAccordBot/1.0)' },
    })
    const html = await res.text()
    return { html, url, usedBrowser: false }
  }

  extractArticleData(html: string): ExtractedArticleData {
    const $ = cheerio.load(html)

    const title =
      $('meta[property="og:title"]').attr('content') ??
      $('h1').first().text().trim() ??
      $('title').text().trim() ??
      null

    const metaDescription =
      $('meta[name="description"]').attr('content') ??
      $('meta[property="og:description"]').attr('content') ??
      null

    const author =
      $('meta[name="author"]').attr('content') ??
      $('[rel="author"]').first().text().trim() ??
      $('[class*="author"]').first().text().trim() ??
      null

    const publishedAt =
      $('meta[property="article:published_time"]').attr('content') ??
      $('time[datetime]').first().attr('datetime') ??
      null

    const contentEl =
      $('article').length > 0
        ? $('article')
        : $('[role="main"]').length > 0
          ? $('[role="main"]')
          : $('body')

    contentEl.find('script, style, nav, footer, aside, [class*="ad"], [id*="ad"]').remove()

    const rawContent = contentEl.text().replace(/\s+/g, ' ').trim()
    const content = rawContent.length > 0 ? rawContent : null
    const wordCount = content ? content.split(/\s+/).length : null

    return {
      title: title ?? null,
      content,
      author: author && author.length > 0 ? author : null,
      publishedAt: publishedAt ?? null,
      metaDescription: metaDescription ?? null,
      wordCount,
    }
  }

  requiresBrowser(html: string): boolean {
    const $ = cheerio.load(html)
    const bodyText = $('body').text().trim()
    const hasNoscript = $('noscript').length > 0
    const bodyTooShort = bodyText.length < 200
    const hasJsRoot = $('#root').length > 0 || $('#__next').length > 0 || $('#app').length > 0
    return (bodyTooShort && hasJsRoot) || (bodyTooShort && hasNoscript)
  }
}
