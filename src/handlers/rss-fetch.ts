import { XMLParser } from 'fast-xml-parser'
import type { JobHandler } from '../types/jobs.ts'

interface RssItem {
  title?: string
  link?: string
  pubDate?: string
  description?: string
}

interface RssFeed {
  rss?: { channel?: { item?: RssItem | RssItem[] } }
  feed?: { entry?: RssItem | RssItem[] }
}

const parser = new XMLParser({ ignoreAttributes: false })

export const rssFetchHandler: JobHandler<'rss_fetch'> = {
  type: 'rss_fetch',
  maxAttempts: 3,
  timeoutMs: 30_000,

  async run(payload) {
    const response = await fetch(payload.feedUrl)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching feed ${payload.feedUrl}`)
    }

    const xml = await response.text()
    const parsed = parser.parse(xml) as RssFeed

    const rawItems =
      parsed.rss?.channel?.item ??
      parsed.feed?.entry ??
      []

    const items: RssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems]

    console.log(`[rss_fetch] ${payload.feedUrl}: ${items.length} items`)

    for (const item of items) {
      console.log(`  - ${item.title ?? '(no title)'} ${item.link ?? ''}`)
    }
  },
}
