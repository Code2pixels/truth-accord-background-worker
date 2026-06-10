import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import cron from 'node-cron'
import type { RssSourcesRepository } from '../repositories/rss-sources.repository.ts'
import type { WorkerJobsRepository } from '../repositories/worker-jobs.repository.ts'

const parser = new XMLParser({ ignoreAttributes: false })

interface RssItem {
  link?: string
  guid?: string | { '#text': string }
}

function extractItemUrl(item: RssItem): string | null {
  if (typeof item.link === 'string' && item.link.startsWith('http')) return item.link
  const guid = typeof item.guid === 'string' ? item.guid : item.guid?.['#text']
  if (guid?.startsWith('http')) return guid
  return null
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    // strip common tracking params
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

async function fetchFeed(rssUrl: string): Promise<RssItem[]> {
  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'TruthAccord-RSS-Reader/1.0' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const xml = await res.text()
  const parsed = parser.parse(xml) as Record<string, unknown>
  const channel = (parsed['rss'] as Record<string, unknown> | undefined)?.['channel'] as Record<string, unknown> | undefined
  const items = channel?.['item']
  if (!items) return []
  return (Array.isArray(items) ? items : [items]) as RssItem[]
}

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
    console.log('[RssFeedWorker] Starting feed poll')
    const sources = await this.rssSourcesRepo.findAllActive()
    console.log(`[RssFeedWorker] ${sources.length} active source(s)`)

    let totalQueued = 0
    let totalSkipped = 0

    for (const source of sources) {
      try {
        const items = await fetchFeed(source.rss_url)
        let queued = 0
        let skipped = 0

        for (const item of items) {
          const raw = extractItemUrl(item)
          if (!raw) continue
          const url = normalizeUrl(raw)
          const hash = hashUrl(url)
          const inserted = await this.workerJobsRepo.createIfNew(url, hash)
          if (inserted) queued++
          else skipped++
        }

        console.log(`[RssFeedWorker] ${source.name}: ${items.length} items — ${queued} queued, ${skipped} skipped`)
        totalQueued += queued
        totalSkipped += skipped
      } catch (err) {
        console.error(`[RssFeedWorker] Failed to poll ${source.name} (${source.rss_url}): ${err instanceof Error ? err.message : err}`)
      }
    }

    console.log(`[RssFeedWorker] Done — total queued: ${totalQueued}, skipped: ${totalSkipped}`)
  }
}
