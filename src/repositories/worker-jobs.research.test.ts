import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WorkerJobsRepository } from './worker-jobs.repository.ts'

describe('createResearchJob', () => {
  it('inserts a research_article job with the article id in the payload', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const repo = new WorkerJobsRepository(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return [{ id: 'job-1' }]
    })

    const created = await repo.createResearchJob('article-1', 'https://x.com/a', 'climate')

    assert.equal(created, true)
    assert.match(calls[0]!.sql, /research_article/)
    const payload = JSON.parse(String(calls[0]!.params[0]))
    assert.equal(payload.article_id, 'article-1')
    assert.equal(payload.url, 'https://x.com/a')
    assert.equal(payload.search_term, 'climate')
  })

  it('never sets url_hash, which is globally unique and owned by the scrape job', async () => {
    const calls: string[] = []
    const repo = new WorkerJobsRepository(async (sql: string) => { calls.push(sql); return [{ id: 'j' }] })
    await repo.createResearchJob('article-1', 'https://x.com/a', null)
    assert.ok(!calls[0]!.includes('url_hash'), 'research jobs must leave url_hash NULL')
  })

  it('returns false when the partial unique index rejects a duplicate', async () => {
    const repo = new WorkerJobsRepository(async () => [])
    assert.equal(await repo.createResearchJob('article-1', 'https://x.com/a', null), false)
  })
})
