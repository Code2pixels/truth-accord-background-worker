import { migrate } from './db/migrate.ts'
import { buildExecutor } from './worker/executor.ts'
import { buildReaper } from './worker/reaper.ts'
import { buildScheduler } from './worker/scheduler.ts'
import { scrapeUrlHandler } from './handlers/scrape-url.ts'
import { rssFetchHandler } from './handlers/rss-fetch.ts'
import { csvIngestHandler } from './handlers/csv-ingest.ts'
import { browserScrapeHandler } from './handlers/browser-scrape.ts'
import type { HandlerRegistry } from './types/jobs.ts'

const registry: HandlerRegistry = {
  scrape_url: scrapeUrlHandler,
  rss_fetch: rssFetchHandler,
  csv_ingest: csvIngestHandler,
  browser_scrape: browserScrapeHandler,
}

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  console.log('Running migrations...')
  await migrate()

  const executor = buildExecutor(registry, {
    concurrency: 5,
    onError: (id, err) => console.error(`Job ${id} failed:`, err.message),
  })

  const reaper = buildReaper({ defaultTimeoutMs: 10 * 60 * 1000 })
  const scheduler = buildScheduler()

  await scheduler.start()
  reaper.start()
  executor.start()

  console.log('Worker started.')

  async function shutdown(signal: string): Promise<void> {
    console.log(`\nReceived ${signal}, shutting down...`)
    executor.stop()
    reaper.stop()
    scheduler.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  console.error('Worker failed to start:', err)
  process.exit(1)
})
