import { XMLParser } from 'fast-xml-parser'
import { insertArticle } from '../lib/articles.ts'
import type { JobHandler } from '../types/jobs.ts'

interface RssItem {
  title?: string
  link?: string
  pubDate?: string
  description?: string
  author?: string
  'dc:creator'?: string
}

interface RssFeed {
  rss?: { channel?: { item?: RssItem | RssItem[]; title?: string; link?: string } }
  feed?: { entry?: RssItem | RssItem[]; title?: string; id?: string }
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

    const feedOrigin = new URL(payload.feedUrl).origin
    const feedHostname = new URL(payload.feedUrl).hostname

    const channel = parsed.rss?.channel
    const atomFeed = parsed.feed
    const sourceName = (channel?.title ?? atomFeed?.title ?? feedHostname) as string
    const sourceUrl = (channel?.link ?? atomFeed?.id ?? feedOrigin) as string

    const rawItems = channel?.item ?? atomFeed?.entry ?? []
    const items: RssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems]

    console.log(`[rss_fetch] ${payload.feedUrl}: ${items.length} items`)

    for (const item of items) {
      const url = item.link
      const title = item.title?.trim() ?? ''

      if (!url || !title) continue

      const authored_by = (item.author ?? item['dc:creator'] ?? sourceName).trim()
      const summary = (item.description ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 2000)

      const id = await insertArticle({ url, title, summary, authored_by, source: sourceName, source_url: sourceUrl })
      console.log(`[rss_fetch] inserted article ${id}: ${title}`)
    }
  },
}
