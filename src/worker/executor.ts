import { pool } from '../db/client.ts'
import { backoffDelay } from '../types/jobs.ts'
import type { HandlerRegistry, JobRow } from '../types/jobs.ts'

const POLL_INTERVAL_MS = 5_000
const BATCH_SIZE = 10

interface ExecutorOptions {
  concurrency?: number
  onError?: (jobId: string, err: Error) => void
}

interface Executor {
  dispatch: (job: JobRow) => Promise<void>
  start: () => void
  stop: () => void
}

export function buildExecutor(
  registry: HandlerRegistry,
  options: ExecutorOptions = {}
): Executor {
  const { concurrency = 5, onError } = options
  let running = false
  let timer: NodeJS.Timeout | null = null

  async function dispatch(job: JobRow): Promise<void> {
    const handler = registry[job.type]
    if (!handler) {
      const noHandlerErr = new Error(`No handler for job type: ${job.type}`)
      try {
        await markFailed(job.id, job.attempts, job.max_attempts, noHandlerErr)
      } catch (dbErr) {
        console.error(`Failed to mark job ${job.id} as failed:`, dbErr)
      }
      return
    }

    let handlerError: Error | null = null
    try {
      await (handler as { run: (p: JobRow['payload']) => Promise<void> }).run(job.payload)
    } catch (err) {
      handlerError = err instanceof Error ? err : new Error(String(err))
      onError?.(job.id, handlerError)
    }

    try {
      if (handlerError) {
        await markFailed(job.id, job.attempts, job.max_attempts, handlerError)
      } else {
        await markCompleted(job.id)
      }
    } catch (dbErr) {
      console.error(`Failed to update status for job ${job.id}:`, dbErr)
    }
  }

  async function poll(): Promise<void> {
    const client = await pool.connect()
    let jobs: JobRow[]

    try {
      await client.query('BEGIN')
      const { rows } = await client.query<JobRow>(`
        SELECT * FROM worker.jobs
        WHERE status = 'pending'
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `, [BATCH_SIZE])

      jobs = rows

      if (jobs.length > 0) {
        const ids = jobs.map(j => j.id)
        await client.query(`
          UPDATE worker.jobs
          SET status = 'running', started_at = NOW()
          WHERE id = ANY($1)
        `, [ids])
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      client.release()
      throw err
    }

    client.release()

    // Dispatch in batches respecting concurrency
    const chunks = chunk(jobs, concurrency)
    for (const batch of chunks) {
      await Promise.all(batch.map(dispatch))
    }
  }

  function start(): void {
    running = true
    const tick = async (): Promise<void> => {
      if (!running) return
      try {
        await poll()
      } catch (err) {
        console.error('Executor poll error:', err)
      }
      if (running) timer = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
    }
    timer = setTimeout(() => { void tick() }, 0)
  }

  function stop(): void {
    running = false
    if (timer) clearTimeout(timer)
  }

  return { dispatch, start, stop }
}

async function markCompleted(id: string): Promise<void> {
  await pool.query(`
    UPDATE worker.jobs
    SET status = 'completed', completed_at = NOW()
    WHERE id = $1
  `, [id])
}

async function markFailed(
  id: string,
  attempts: number,
  maxAttempts: number,
  err: Error
): Promise<void> {
  const nextAttempts = attempts + 1
  const isDead = nextAttempts >= maxAttempts
  const delaySecs = backoffDelay(nextAttempts)

  await pool.query(`
    UPDATE worker.jobs
    SET
      status = $1,
      attempts = $2,
      last_error = $3,
      scheduled_at = CASE WHEN $1 = 'pending' THEN NOW() + ($4 || ' seconds')::interval ELSE scheduled_at END
    WHERE id = $5
  `, [
    isDead ? 'dead' : 'pending',
    nextAttempts,
    err.stack ?? err.message,
    delaySecs.toString(),
    id,
  ])
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}
