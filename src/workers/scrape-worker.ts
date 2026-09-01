import type { ScraperService } from '../services/scraper/scraper.service.ts'
import type { WaybackService } from '../services/wayback/wayback.service.ts'
import type { ArticlesService } from '../services/articles.service.ts'
import type { WorkerJobsRepository } from '../repositories/worker-jobs.repository.ts'
import type { ArticleContentRepository } from '../repositories/article-content.repository.ts'
import type { SourcesRepository } from '../repositories/sources.repository.ts'
import type { ScrapeJob } from '../types.ts'
import { bad, dim, jobId, ok, step, tag, value, warn } from '../utils/log.util.ts'
import { isVideoArticle } from '../services/media-filter.ts'

export class ScrapeWorker {
  private isRunning = false
  private timer: NodeJS.Timeout | null = null
  private readonly concurrency: number
  private readonly maxRetries: number

  constructor(
    private readonly scraper: ScraperService,
    private readonly wayback: WaybackService,
    private readonly articles: ArticlesService,
    private readonly workerJobsRepo: WorkerJobsRepository,
    private readonly articleContentRepo: ArticleContentRepository,
    private readonly sourcesRepo: SourcesRepository,
  ) {
    this.concurrency = Number(process.env['QUEUE_CONCURRENCY'] ?? 3)
    this.maxRetries = Number(process.env['MAX_RETRIES'] ?? 3)
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.poll(), intervalMs)
    console.log(`${tag('ScrapeWorker')} Started — polling every ${value(intervalMs)}ms, concurrency=${value(this.concurrency)}, maxRetries=${value(this.maxRetries)}`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    console.log(`${tag('ScrapeWorker')} Stopped`)
  }

  private async poll(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      const reset = await this.workerJobsRepo.resetStuckRunning(5)
      if (reset > 0) console.log(`${tag('ScrapeWorker')} ${warn(`Reset ${reset} stuck job(s) back to pending`)}`)

      const jobs = await this.workerJobsRepo.claimPending(this.concurrency)
      if (jobs.length === 0) return

      console.log(`${tag('ScrapeWorker')} Claimed ${value(jobs.length)} job(s)`)
      await Promise.all(jobs.map((job) => this.processJob(job)))
    } catch (err) {
      console.error(`${tag('ScrapeWorker')} ${bad('Poll error:')}`, err instanceof Error ? err.message : err)
    } finally {
      this.isRunning = false
    }
  }

  private async processJob(job: ScrapeJob): Promise<void> {
    const { id, url } = job
    const t0 = Date.now()
    const prefix = jobId(id)
    console.log(`${prefix} ${dim('── START ──────────────────────────────')}`)
    console.log(`${prefix} URL:         ${value(url)}`)
    console.log(`${prefix} Search term: ${job.search_term ?? dim('(none)')}`)
    console.log(`${prefix} Attempt:     ${job.attempts + 1}/${job.max_attempts}`)

    try {
      // Step 1: Scrape
      console.log(`${prefix} ${step(1, 4)} Fetching URL...`)
      let scraped = await this.scraper.scrape(url)
      const sourceDomain = new URL(url).hostname
      console.log(`${prefix}       title:       ${scraped.title ?? dim('(none)')}`)
      console.log(`${prefix}       author:      ${scraped.author ?? dim('(none)')}`)
      console.log(`${prefix}       word count:  ${scraped.wordCount ?? 0}`)
      console.log(`${prefix}       published:   ${scraped.publishedAt ?? dim('(unknown)')}`)
      console.log(`${prefix}       paywall:     ${scraped.paywallDetected ? warn('yes') : dim('no')}`)
      console.log(`${prefix}       links:       ${scraped.links.length}`)

      // Step 2: Paywall / Wayback fallback
      if (scraped.paywallDetected) {
        console.warn(`${prefix} ${step(2, 4)} ${warn(`Paywall detected — marking ${sourceDomain} and checking Wayback Machine...`)}`)
        await this.sourcesRepo.markPaywall(sourceDomain)

        const snapshot = await this.wayback.getLatestSnapshot(url)
        if (snapshot) {
          console.log(`${prefix}       Wayback snapshot found: ${value(snapshot.url)} (${snapshot.timestamp})`)
          scraped = await this.scraper.scrape(snapshot.url, { forceStatic: true })
          scraped.isArchived = true
          scraped.snapshotTimestamp = snapshot.timestamp
          scraped.url = url
          console.log(`${prefix}       Re-scraped via archive — word count: ${scraped.wordCount ?? 0}`)
        } else {
          console.warn(`${prefix}       ${warn('No Wayback snapshot available — marking unarchivable, failing job')}`)
          await this.sourcesRepo.markUnarchivable(sourceDomain)
          await this.workerJobsRepo.failWithRetry(id, 'Paywalled — no archive snapshot found')
          console.log(`${prefix} ${bad('── FAILED (paywall, no archive)')} ${dim(`[${Date.now() - t0}ms]`)}`)
          return
        }
      } else {
        console.log(`${prefix} ${step(2, 4)} No paywall detected`)
      }

      // A video package reaches the same dead end every time: no body to
      // classify, nothing to corroborate. Stop before the article row exists.
      if (isVideoArticle(scraped.title)) {
        console.log(`${prefix}       ${dim(`skipping video package: ${scraped.title ?? ''}`)}`)
        await this.workerJobsRepo.updateStatus(id, 'completed')
        console.log(`${prefix} ${dim('── SKIPPED (video)')} ${dim(`[${Date.now() - t0}ms]`)}`)
        return
      }

      // Step 3: Ensure source domain is tracked
      console.log(`${prefix} ${step(3, 4)} Ensuring source domain: ${value(sourceDomain)}`)
      await this.sourcesRepo.ensureExists(sourceDomain)

      // Step 4: Hand off to the research service. The article lands as `pending`
      // with no category — truth-accord-research decides both.
      console.log(`${prefix} ${step(4, 4)} Upserting article and queueing research...`)
      const article = await this.articles.upsert({
        url: scraped.url,
        title: scraped.title,
        author: scraped.author,
        publishedAt: scraped.publishedAt,
        sourceDomain,
        isArchived: scraped.isArchived,
        snapshotTimestamp: scraped.snapshotTimestamp,
        metaDescription: scraped.metaDescription,
        wordCount: scraped.wordCount,
        status: 'pending',
        category: null,
      })
      console.log(`${prefix}       article.id: ${value(article.id)}`)

      await this.articleContentRepo.upsert(article.id, scraped.content ?? '', scraped.links)
      const queued = await this.workerJobsRepo.createResearchJob(article.id, scraped.url, job.search_term)
      if (!queued) console.log(`${prefix}       ${dim(`research job already queued for ${article.id}`)}`)
      await this.workerJobsRepo.updateStatus(id, 'completed')

      const elapsed = Date.now() - t0
      console.log(`${prefix} ${ok('── COMPLETED')} ${dim(`[${elapsed}ms] ──────────────`)}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      console.error(`${prefix} ${bad('── ERROR ──────────────────────────────')}`)
      console.error(`${prefix} ${bad(message)}`)
      if (stack) console.error(`${prefix} ${dim(stack)}`)
      await this.workerJobsRepo.failWithRetry(id, message)
      console.log(`${prefix} ${bad(`── FAILED (attempt ${job.attempts + 1}/${job.max_attempts})`)} ${dim(`[${Date.now() - t0}ms]`)}`)
    }
  }
}
