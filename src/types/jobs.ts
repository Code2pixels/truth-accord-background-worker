export interface JobPayload {
  scrape_url: { url: string; selector?: string }
  rss_fetch: { feedUrl: string }
  csv_ingest: { filePath: string; delimiter?: string }
  browser_scrape: { url: string; waitFor?: string }
}

export type JobType = keyof JobPayload

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead'

export interface JobRow {
  id: string
  type: JobType
  payload: JobPayload[JobType]
  status: JobStatus
  scheduled_at: Date
  started_at: Date | null
  completed_at: Date | null
  attempts: number
  max_attempts: number
  last_error: string | null
  created_at: Date
}

export interface ScheduleRow {
  id: string
  type: JobType
  payload: JobPayload[JobType]
  cron: string
  enabled: boolean
  last_run_at: Date | null
  next_run_at: Date | null
  created_at: Date
}

export interface JobHandler<T extends JobType> {
  type: T
  maxAttempts?: number
  timeoutMs?: number
  run: (payload: JobPayload[T]) => Promise<void>
}

export type HandlerRegistry = {
  [T in JobType]?: JobHandler<T>
}

export const BACKOFF_SECONDS = [30, 120, 600] as const

export function backoffDelay(attempts: number): number {
  const index = Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
  return BACKOFF_SECONDS[index] ?? 600
}
