import cron from 'node-cron'
import { pool } from './db/client.ts'
import { WorkerJobsRepository } from './repositories/worker-jobs.repository.ts'
import { ArticlesRepository } from './repositories/articles.repository.ts'
import { ArticleContentRepository } from './repositories/article-content.repository.ts'
import { SourcesRepository } from './repositories/sources.repository.ts'
import { StaticScraperService } from './services/scraper/static-scraper.service.ts'
import { DynamicScraperService } from './services/scraper/dynamic-scraper.service.ts'
import { ScraperService } from './services/scraper/scraper.service.ts'
import { WaybackService } from './services/wayback/wayback.service.ts'
import { ArticlesService } from './services/articles.service.ts'
import { ScrapeWorker } from './workers/scrape-worker.ts'
import { WaybackRecheckWorker } from './workers/wayback-recheck.ts'
import { RssFeedWorker } from './workers/rss-feed.worker.ts'
import { RssSourcesRepository } from './repositories/rss-sources.repository.ts'
import { bad, ok, tag, warn } from './utils/log.util.ts'

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    console.error(bad('DATABASE_URL environment variable is required'))
    process.exit(1)
  }

  const pollIntervalMs = Number(process.env['QUEUE_POLL_INTERVAL_MS'] ?? 5_000)

  // Repositories
  const workerJobsRepo = new WorkerJobsRepository()
  const rssSourcesRepo = new RssSourcesRepository()
  const articlesRepo = new ArticlesRepository()
  const articleContentRepo = new ArticleContentRepository()
  const sourcesRepo = new SourcesRepository()

  // Services
  const staticScraper = new StaticScraperService()
  const dynamicScraper = new DynamicScraperService()
  const scraper = new ScraperService(staticScraper, dynamicScraper)
  const wayback = new WaybackService()
  const articles = new ArticlesService(articlesRepo)

  // Workers
  const scrapeWorker = new ScrapeWorker(
    scraper, wayback, articles, workerJobsRepo, articleContentRepo, sourcesRepo,
  )
  const waybackRecheckWorker = new WaybackRecheckWorker(workerJobsRepo, wayback)

  const rssFeedWorker = new RssFeedWorker(rssSourcesRepo, workerJobsRepo)

  scrapeWorker.start(pollIntervalMs)
  waybackRecheckWorker.schedule()
  rssFeedWorker.schedule()

  // Keep the API's per-source article counts (sources.article_counts matview)
  // fresh. Runs on its own cron so reads stay O(sources) no matter how large
  // articles.records grows.
  const articleCountsCron = process.env['ARTICLE_COUNTS_REFRESH_CRON'] ?? '*/15 * * * *'
  cron.schedule(articleCountsCron, () => {
    void sourcesRepo
      .refreshArticleCounts()
      .then(() => console.log(`${tag('main')} Refreshed sources.article_counts`))
      .catch((err: unknown) =>
        console.error(`${tag('main')} ${bad('Failed to refresh sources.article_counts:')}`, err instanceof Error ? err.message : err),
      )
  })
  console.log(`${tag('main')} sources.article_counts refresh scheduled — cron: ${articleCountsCron}`)

  console.log(`${tag('main')} ${ok('Background worker running')}`)

  async function shutdown(): Promise<void> {
    console.log(`${tag('main')} Shutting down...`)
    scrapeWorker.stop()
    await dynamicScraper.destroy()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  // undici (Node fetch) throws errors synchronously from TLS/socket event handlers
  // when connections are closed or reset mid-response. These bypass async/await catch
  // blocks entirely. Treat them as transient and log rather than crash.
  const TRANSIENT_NETWORK_CODES = new Set([
    'ERR_ASSERTION',   // undici TLS connection-close (original case)
    'ECONNRESET',      // remote peer closed connection unexpectedly
    'ECONNREFUSED',    // remote refused the connection
    'ETIMEDOUT',       // connection or read timed out
    'ENOTFOUND',       // DNS resolution failure
    'EPROTO',          // SSL/TLS protocol error
  ])
  process.on('uncaughtException', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    if (TRANSIENT_NETWORK_CODES.has(code ?? '')) {
      console.warn(`${tag('main')} ${warn(`Swallowed transient network error (${code ?? err.name})`)}: ${err.message}`)
      return
    }
    console.error(`${tag('main')} ${bad('Uncaught exception — shutting down:')}`, err)
    void shutdown()
  })

  // Prevent unhandled promise rejections from crashing the process.
  // Individual workers catch their own errors; this is a last-resort safety net.
  process.on('unhandledRejection', (reason) => {
    console.error(`${tag('main')} ${bad('Unhandled rejection:')}`, reason instanceof Error ? reason.message : reason)
  })
}

main().catch((err: unknown) => {
  console.error(`${tag('main')} ${bad('Fatal error:')}`, err)
  process.exit(1)
})
