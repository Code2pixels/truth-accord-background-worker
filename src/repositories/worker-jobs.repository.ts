import { query, queryOne } from '../db/client.ts'
import type { ScrapeJob, JobStatus, QueueStats } from '../types.ts'

const BACKOFF_SECONDS = [30, 120, 600] as const

function backoffDelay(attempts: number): number {
  const index = Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
  return BACKOFF_SECONDS[index] ?? 600
}

interface RawJobRow {
  id: string
  payload: { url: string; search_term?: string | null; wayback_recheck_queued_at?: string | null }
  status: JobStatus
  attempts: number
  max_attempts: number
  last_error: string | null
}

function toScrapeJob(row: RawJobRow): ScrapeJob {
  return {
    id: row.id,
    url: row.payload.url,
    search_term: row.payload.search_term ?? null,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_error: row.last_error,
  }
}

export class WorkerJobsRepository {
  async create(url: string, searchTerm?: string | null): Promise<ScrapeJob> {
    const payload = JSON.stringify({ url, search_term: searchTerm ?? null })
    const row = await queryOne<RawJobRow>(
      `INSERT INTO worker.jobs (type, payload)
       VALUES ('scrape_url', $1)
       RETURNING id, payload, status, attempts, max_attempts, last_error`,
      [payload],
    )
    if (!row) throw new Error(`Failed to create job for: ${url}`)
    return toScrapeJob(row)
  }

  async createIfNew(url: string, urlHash: string, searchTerm?: string | null): Promise<boolean> {
    const payload = JSON.stringify({ url, search_term: searchTerm ?? null })
    const row = await queryOne<{ id: string }>(
      `INSERT INTO worker.jobs (type, payload, url_hash)
       VALUES ('scrape_url', $1, $2)
       ON CONFLICT (url_hash) WHERE url_hash IS NOT NULL DO NOTHING
       RETURNING id`,
      [payload, urlHash],
    )
    return row !== null
  }

  async updateStatus(id: string, status: 'completed' | 'failed'): Promise<void> {
    await query(
      `UPDATE worker.jobs SET status = $1 WHERE id = $2`,
      [status, id],
    )
  }

  async failWithRetry(id: string, errorMessage: string): Promise<void> {
    const rows = await query<{ attempts: number; max_attempts: number }>(
      `SELECT attempts, max_attempts FROM worker.jobs WHERE id = $1`,
      [id],
    )
    const row = rows[0]
    if (!row) return

    const nextAttempts = row.attempts + 1
    const isDead = nextAttempts >= row.max_attempts
    const delaySecs = backoffDelay(nextAttempts)

    await query(
      `UPDATE worker.jobs
       SET status       = $1,
           attempts     = $2,
           last_error   = $3,
           scheduled_at = CASE WHEN $1 = 'pending' THEN NOW() + ($4 || ' seconds')::interval ELSE scheduled_at END
       WHERE id = $5`,
      [isDead ? 'dead' : 'pending', nextAttempts, errorMessage, delaySecs.toString(), id],
    )
  }

  async claimPending(limit: number): Promise<ScrapeJob[]> {
    const rows = await query<RawJobRow>(
      `UPDATE worker.jobs
       SET status = 'running', started_at = NOW()
       WHERE id IN (
         SELECT id FROM worker.jobs
         WHERE type = 'scrape_url'
           AND status = 'pending'
           AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, payload, status, attempts, max_attempts, last_error`,
      [limit],
    )
    return rows.map(toScrapeJob)
  }

  async resetStuckRunning(olderThanMinutes: number): Promise<number> {
    const rows = await query<{ count: number }>(
      olderThanMinutes <= 0
        ? `WITH updated AS (
             UPDATE worker.jobs
             SET status = 'pending', started_at = NULL
             WHERE type = 'scrape_url' AND status = 'running'
             RETURNING 1
           )
           SELECT COUNT(*)::int AS count FROM updated`
        : `WITH updated AS (
             UPDATE worker.jobs
             SET status = 'pending', started_at = NULL
             WHERE type = 'scrape_url'
               AND status = 'running'
               AND started_at < NOW() - ($1 * interval '1 minute')
             RETURNING 1
           )
           SELECT COUNT(*)::int AS count FROM updated`,
      olderThanMinutes <= 0 ? [] : [olderThanMinutes],
    )
    return rows[0]?.count ?? 0
  }

  async findFailedWaybackRecheckCandidates(
    limit: number,
    olderThanHours: number,
  ): Promise<Array<{ id: string; url: string }>> {
    return query<{ id: string; url: string }>(
      `SELECT id, payload->>'url' AS url
       FROM worker.jobs
       WHERE type = 'scrape_url'
         AND status IN ('failed', 'dead')
         AND last_error LIKE '%no archive snapshot%'
         AND (
           payload->>'wayback_recheck_queued_at' IS NULL
           OR (payload->>'wayback_recheck_queued_at')::timestamptz < NOW() - ($1 * interval '1 hour')
         )
       ORDER BY (payload->>'wayback_recheck_queued_at')::timestamptz ASC NULLS FIRST
       LIMIT $2`,
      [olderThanHours, limit],
    )
  }

  async markWaybackRecheckQueued(id: string): Promise<void> {
    await query(
      `UPDATE worker.jobs
       SET payload = payload || jsonb_build_object('wayback_recheck_queued_at', NOW()::text)
       WHERE id = $1`,
      [id],
    )
  }

  async getStats(): Promise<QueueStats> {
    const rows = await query<{ status: JobStatus; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM worker.jobs WHERE type = 'scrape_url' GROUP BY status`,
    )
    const m = new Map(rows.map((r) => [r.status, r.count]))
    return {
      pending: m.get('pending') ?? 0,
      running: m.get('running') ?? 0,
      completed: m.get('completed') ?? 0,
      failed: m.get('failed') ?? 0,
      dead: m.get('dead') ?? 0,
    }
  }
}
