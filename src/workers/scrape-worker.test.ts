import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ScrapeWorker } from './scrape-worker.ts'
import type { ScrapeJob } from '../types.ts'

function makeWorker(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const scraped = {
    url: 'https://news.example.com/a', title: 'A title', content: 'body '.repeat(200),
    author: 'Jane Doe', publishedAt: null, metaDescription: 'A description',
    wordCount: 200, isArchived: false, snapshotTimestamp: null, paywallDetected: false,
    links: [{ url: 'https://gov.uk/x', anchor: 'report', rel: null }],
  }
  const deps = {
    scraper: { scrape: async () => scraped },
    wayback: { getLatestSnapshot: async () => null },
    articles: { upsert: async (input: { status?: string }) => { calls.push(`upsert:${input.status}`); return { id: 'article-1', url: scraped.url } } },
    workerJobsRepo: {
      createResearchJob: async (id: string) => { calls.push(`research:${id}`); return true },
      updateStatus: async (_id: string, s: string) => { calls.push(`job:${s}`) },
      failWithRetry: async () => { calls.push('job:retry') },
    },
    articleContentRepo: { upsert: async () => { calls.push('content') } },
    sourcesRepo: { ensureExists: async () => {}, markPaywall: async () => {}, markUnarchivable: async () => {} },
    ...overrides,
  }
  // constructor order matches src/workers/scrape-worker.ts
  const worker = new ScrapeWorker(
    deps.scraper as never, deps.wayback as never, deps.articles as never,
    deps.workerJobsRepo as never, deps.articleContentRepo as never, deps.sourcesRepo as never,
  )
  return { worker, calls }
}

const job: ScrapeJob = {
  id: 'job-1', url: 'https://news.example.com/a', search_term: 'climate',
  status: 'running', attempts: 0, max_attempts: 3, last_error: null,
}

describe('ScrapeWorker.processJob', () => {
  it('inserts the article as pending, stores content, then enqueues research', async () => {
    const { worker, calls } = makeWorker()
    await (worker as unknown as { processJob(j: ScrapeJob): Promise<void> }).processJob(job)
    assert.deepEqual(calls, ['upsert:pending', 'content', 'research:article-1', 'job:completed'])
  })

  it('makes no LLM or similar-article calls', () => {
    // The constructor no longer accepts ollama/truthfulness/referenceSitesCrawl deps.
    assert.equal(ScrapeWorker.length, 6)
  })

  it('never inserts a video package', async () => {
    const { worker, calls } = makeWorker({
      scraper: {
        scrape: async () => ({
          url: 'https://news.example.com/a', title: 'Video: Marine One suffers a failure',
          content: 'body', author: null, publishedAt: null, metaDescription: 'd',
          wordCount: 12, isArchived: false, snapshotTimestamp: null, paywallDetected: false,
          links: [],
        }),
      },
    })
    await (worker as unknown as { processJob(j: ScrapeJob): Promise<void> }).processJob(job)
    assert.ok(!calls.some((c) => c.startsWith('upsert')), 'no article row for a video')
    assert.ok(!calls.some((c) => c.startsWith('research')), 'no research job for a video')
    assert.deepEqual(calls, ['job:completed'])
  })

  it('fails the job with retry when scraping throws', async () => {
    const { worker, calls } = makeWorker({ scraper: { scrape: async () => { throw new Error('boom') } } })
    await (worker as unknown as { processJob(j: ScrapeJob): Promise<void> }).processJob(job)
    assert.ok(calls.includes('job:retry'))
  })
})
