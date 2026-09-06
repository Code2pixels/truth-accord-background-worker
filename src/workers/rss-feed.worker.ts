import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import cron from 'node-cron'
import type { RssSourcesRepository } from '../repositories/rss-sources.repository.ts'
import type { WorkerJobsRepository } from '../repositories/worker-jobs.repository.ts'
import { ScopeGateService } from '../services/scope-gate.service.ts'
import { isVideoArticle } from '../services/media-filter.ts'
import { feedCategoryVerdict, isAllowedTopic } from '../services/topic-classifier.ts'
import { bad, dim, ok, tag, value, warn } from '../utils/log.util.ts'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

interface FeedItem {
  title?: string | { '#text': string }
  description?: string | { '#text': string }
  summary?: string | { '#text': string }
  link?: string | { '#text': string } | Array<{ '@_rel'?: string; '@_href'?: string } | string>
  guid?: string | { '#text': string }
  id?: string
  category?: string | string[] | { '@_term'?: string } | Array<{ '@_term'?: string }>
}

function extractText(val: string | { '#text': string } | undefined): string {
  if (!val) return ''
  if (typeof val === 'string') return val
  return val['#text'] ?? ''
}

function extractCategories(item: FeedItem): string[] {
  const { category } = item
  if (!category) return []

  const toStr = (c: string | { '@_term'?: string }): string | null => {
    if (typeof c === 'string') return c
    return c['@_term'] ?? null
  }

  if (Array.isArray(category)) {
    return category.flatMap((c) => { const s = toStr(c); return s ? [s] : [] })
  }
  const s = toStr(category)
  return s ? [s] : []
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
    private readonly scopeGate: ScopeGateService = new ScopeGateService(),
  ) {}

  schedule(): void {
    const cronExpr = process.env['RSS_FEED_CRON'] ?? '*/30 * * * *'
    cron.schedule(cronExpr, () => void this.run())
    console.log(`${tag('RssFeedWorker')} Scheduled — cron: ${value(cronExpr)}`)
    void this.run()
  }

  async run(): Promise<void> {
    const batchSize = Number(process.env['RSS_FEED_BATCH_SIZE'] ?? 3)
    const batchDelayMs = Number(process.env['RSS_FEED_BATCH_DELAY_MS'] ?? 5_000)

    console.log(`${tag('RssFeedWorker')} Starting feed poll`)
    const sources = await this.rssSourcesRepo.findAllActive()
    console.log(`${tag('RssFeedWorker')} ${value(sources.length)} active source(s), batch size: ${batchSize}, delay: ${batchDelayMs}ms`)

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
          let offTarget = 0

          const candidates: Array<{ url: string; topicText: string }> = []
          for (const item of items) {
            const raw = extractUrl(item)
            if (!raw) continue
            const rssCategories = extractCategories(item)
            const itemTitle = extractText(item.title)
            // A video package has no body to classify and nothing to corroborate.
            if (isVideoArticle(itemTitle)) {
              offTarget++
              continue
            }
            const topicText = `${itemTitle} ${extractText(item.description ?? item.summary)}`
            if (!isAllowedTopic(topicText, rssCategories)) continue
            // The feed filed this under a category nobody researches — skip the
            // scrape, the article row and the research job entirely.
            if (feedCategoryVerdict(rssCategories) === 'off-target') {
              offTarget++
              continue
            }
            candidates.push({ url: normalizeUrl(raw), topicText })
          }

          // One embedding call for the whole feed decides what is worth
          // scraping. Two thirds of what this worker used to queue was rejected
          // downstream for being off topic, after paying for the scrape.
          const inScope = await this.scopeGate.keep(candidates.map((c) => c.topicText))

          for (const [i, candidate] of candidates.entries()) {
            if (inScope[i] === false) {
              offTarget++
              continue
            }
            const hash = hashUrl(candidate.url)
            try {
              const inserted = await this.workerJobsRepo.createIfNew(candidate.url, hash)
              if (inserted) queued++
              else skipped++
            } catch (err) {
              failed++
              console.warn(`${tag('RssFeedWorker')} ${source.name}: ${warn(`failed to queue ${candidate.url}`)}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          console.log(`${tag('RssFeedWorker')} ${source.name}: ${items.length} items — ${queued > 0 ? ok(`${queued} queued`) : `${queued} queued`}, ${dim(`${skipped} skipped`)}${offTarget > 0 ? dim(`, ${offTarget} off-target`) : ''}${failed > 0 ? `, ${bad(`${failed} failed`)}` : ''}`)
          totalQueued += queued
          totalSkipped += skipped
        } catch (err) {
          console.error(`${tag('RssFeedWorker')} ${bad(`Failed to poll ${source.name}`)} (${source.rss_url}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }))
    }

    console.log(`${tag('RssFeedWorker')} Done — total queued: ${ok(String(totalQueued))}, skipped: ${dim(String(totalSkipped))}`)
  }
}
