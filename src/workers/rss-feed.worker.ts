import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import cron from 'node-cron'
import type { RssSourcesRepository } from '../repositories/rss-sources.repository.ts'
import type { WorkerJobsRepository } from '../repositories/worker-jobs.repository.ts'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

interface FeedItem {
  link?: string | { '#text': string } | Array<{ '@_rel'?: string; '@_href'?: string } | string>
  guid?: string | { '#text': string }
  id?: string
}

function extractUrl(item: FeedItem): string | null {
  const { link, guid, id } = item

  // Atom: link is an array of objects with @_rel and @_href
  if (Array.isArray(link)) {
    const alternate = link.find(
      (l): l is { '@_rel'?: string; '@_href'?: string } =>
        typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'),
    )
    const href = alternate?.['@_href']
    if (href?.startsWith('http')) return href
  }

  // Atom: link is a single object
  if (typeof link === 'object' && link !== null && !Array.isArray(link)) {
    const href = (link as { '@_href'?: string })['@_href']
    if (href?.startsWith('http')) return href
  }

  // RSS: link is a plain string
  if (typeof link === 'string' && link.startsWith('http')) return link

  // RSS: guid is a URL
  const guidStr = typeof guid === 'string' ? guid : guid?.['#text']
  if (guidStr?.startsWith('http')) return guidStr

  // Atom: id is a URL
  if (typeof id === 'string' && id.startsWith('http')) return id

  return null
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      u.searchParams.delete(p)
    }
    return u.toString().replace(/\/$/, '')
  } catch {
    return raw.trim()
  }
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function extractItems(parsed: Record<string, unknown>): FeedItem[] {
  // RSS 2.0
  const channel = (parsed['rss'] as Record<string, unknown> | undefined)?.['channel'] as Record<string, unknown> | undefined
  if (channel) {
    const items = channel['item']
    if (items) return (Array.isArray(items) ? items : [items]) as FeedItem[]
  }

  // Atom
  const feed = parsed['feed'] as Record<string, unknown> | undefined
  if (feed) {
    const entries = feed['entry']
    if (entries) return (Array.isArray(entries) ? entries : [entries]) as FeedItem[]
  }

  return []
}

async function fetchFeed(rssUrl: string): Promise<FeedItem[]> {
  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'TruthAccord-RSS-Reader/1.0' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const xml = await res.text()
  const parsed = parser.parse(xml) as Record<string, unknown>
  return extractItems(parsed)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class RssFeedWorker {
  constructor(
    private readonly rssSourcesRepo: RssSourcesRepository,
    private readonly workerJobsRepo: WorkerJobsRepository,
  ) {}

  schedule(): void {
    const cronExpr = process.env['RSS_FEED_CRON'] ?? '*/30 * * * *'
    cron.schedule(cronExpr, () => void this.run())
    console.log(`[RssFeedWorker] Scheduled — cron: ${cronExpr}`)
    void this.run()
  }

  async run(): Promise<void> {
    const batchSize = Number(process.env['RSS_FEED_BATCH_SIZE'] ?? 3)
    const batchDelayMs = Number(process.env['RSS_FEED_BATCH_DELAY_MS'] ?? 5_000)

    console.log('[RssFeedWorker] Starting feed poll')
    const sources = await this.rssSourcesRepo.findAllActive()
    console.log(`[RssFeedWorker] ${sources.length} active source(s), batch size: ${batchSize}, delay: ${batchDelayMs}ms`)

    let totalQueued = 0
    let totalSkipped = 0

    for (let i = 0; i < sources.length; i += batchSize) {
      if (i > 0) await sleep(batchDelayMs)

      const batch = sources.slice(i, i + batchSize)
      await Promise.all(batch.map(async (source) => {
        try {
          const items = await fetchFeed(source.rss_url)
          let queued = 0
          let skipped = 0
          let failed = 0

          for (const item of items) {
            const raw = extractUrl(item)
            if (!raw) continue
            const url = normalizeUrl(raw)
            const hash = hashUrl(url)
            try {
              const inserted = await this.workerJobsRepo.createIfNew(url, hash)
              if (inserted) queued++
              else skipped++
            } catch (err) {
              failed++
              console.warn(`[RssFeedWorker] ${source.name}: failed to queue ${url}: ${err instanceof Error ? err.message : err}`)
            }
          }

          console.log(`[RssFeedWorker] ${source.name}: ${items.length} items — ${queued} queued, ${skipped} skipped${failed > 0 ? `, ${failed} failed` : ''}`)
          totalQueued += queued
          totalSkipped += skipped
        } catch (err) {
          console.error(`[RssFeedWorker] Failed to poll ${source.name} (${source.rss_url}): ${err instanceof Error ? err.message : err}`)
        }
      }))
    }

    console.log(`[RssFeedWorker] Done — total queued: ${totalQueued}, skipped: ${totalSkipped}`)
  }
}
