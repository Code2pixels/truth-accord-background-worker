import { insertArticle, extractHtmlMeta } from '../lib/articles.ts'
import type { JobHandler } from '../types/jobs.ts'

export const scrapeUrlHandler: JobHandler<'scrape_url'> = {
  type: 'scrape_url',
  maxAttempts: 3,
  timeoutMs: 30_000,

  async run(payload) {
    const response = await fetch(payload.url)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${payload.url}`)
    }

    const html = await response.text()
    const article = extractHtmlMeta(html, payload.url)

    if (payload.selector) {
      const tagMatch = payload.selector.match(/^([a-z][a-z0-9]*)$/i)
      if (tagMatch) {
        const tag = tagMatch[1]
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
        const match = html.match(regex)
        const text = match ? match[1]?.replace(/<[^>]+>/g, '').trim() : ''
        if (text && !article.summary) article.summary = text.slice(0, 1000)
      }
    }

    const id = await insertArticle(article)
    console.log(`[scrape_url] inserted article ${id} for ${payload.url}`)
  },
}
