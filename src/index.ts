import { pool } from './db/client.ts'
import { WorkerJobsRepository } from './repositories/worker-jobs.repository.ts'
import { ArticlesRepository } from './repositories/articles.repository.ts'
import { ArticleTruthfulnessScoresRepository } from './repositories/article-truthfulness-scores.repository.ts'
import { SimilarArticlesRepository } from './repositories/similar-articles.repository.ts'
import { SourcesRepository } from './repositories/sources.repository.ts'
import { StaticScraperService } from './services/scraper/static-scraper.service.ts'
import { DynamicScraperService } from './services/scraper/dynamic-scraper.service.ts'
import { ScraperService } from './services/scraper/scraper.service.ts'
import { WaybackService } from './services/wayback/wayback.service.ts'
import { ReferenceSitesCrawlService } from './services/truthfulness/reference-sites-crawl.service.ts'
import { TruthfulnessService } from './services/truthfulness/truthfulness.service.ts'
import { ArticlesService } from './services/articles.service.ts'
import { ScrapeWorker } from './workers/scrape-worker.ts'
import { WaybackRecheckWorker } from './workers/wayback-recheck.ts'

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pollIntervalMs = Number(process.env['QUEUE_POLL_INTERVAL_MS'] ?? 5_000)

  // Repositories
  const workerJobsRepo = new WorkerJobsRepository()
  const articlesRepo = new ArticlesRepository()
  const truthfulnessScoresRepo = new ArticleTruthfulnessScoresRepository()
  const similarArticlesRepo = new SimilarArticlesRepository()
  const sourcesRepo = new SourcesRepository()

  // Services
  const staticScraper = new StaticScraperService()
  const dynamicScraper = new DynamicScraperService()
  const scraper = new ScraperService(staticScraper, dynamicScraper)
  const wayback = new WaybackService()
  const referenceSitesCrawl = new ReferenceSitesCrawlService()
  const truthfulness = new TruthfulnessService(referenceSitesCrawl)
  const articles = new ArticlesService(articlesRepo)

  // Workers
  const scrapeWorker = new ScrapeWorker(
    scraper, wayback, articles, workerJobsRepo, truthfulnessScoresRepo,
    similarArticlesRepo, truthfulness, referenceSitesCrawl, sourcesRepo,
  )
  const waybackRecheckWorker = new WaybackRecheckWorker(workerJobsRepo, wayback)

  scrapeWorker.start(pollIntervalMs)
  waybackRecheckWorker.schedule()

  console.log('[main] Background worker running')

  async function shutdown(): Promise<void> {
    console.log('[main] Shutting down...')
    scrapeWorker.stop()
    await dynamicScraper.destroy()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((err: unknown) => {
  console.error('[main] Fatal error:', err)
  process.exit(1)
})
