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

    if (payload.selector) {
      // Extract text content of the first element matching the selector pattern
      // For full DOM querying use the browser_scrape handler instead
      const tagMatch = payload.selector.match(/^([a-z][a-z0-9]*)$/i)
      if (tagMatch) {
        const tag = tagMatch[1]
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
        const match = html.match(regex)
        const text = match ? match[1]?.replace(/<[^>]+>/g, '').trim() : ''
        console.log(`[scrape_url] ${payload.url} selector="${payload.selector}": ${text?.slice(0, 200)}`)
        return
      }
    }

    console.log(`[scrape_url] ${payload.url}: fetched ${html.length} bytes`)
  },
}
