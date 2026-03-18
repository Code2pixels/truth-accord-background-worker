import { pool } from '../db/client.ts'

const REAPER_INTERVAL_MS = 60_000

interface ReaperOptions {
  defaultTimeoutMs?: number
}

interface Reaper {
  start: () => void
  stop: () => void
}

export function buildReaper(options: ReaperOptions = {}): Reaper {
  const { defaultTimeoutMs = 10 * 60 * 1000 } = options
  let running = false
  let timer: NodeJS.Timeout | null = null

  async function reap(): Promise<void> {
    const timeoutSecs = Math.floor(defaultTimeoutMs / 1000)
    const { rowCount } = await pool.query(`
      UPDATE worker.jobs
      SET status = 'pending', started_at = NULL
      WHERE status = 'running'
        AND started_at < NOW() - ($1 || ' seconds')::interval
    `, [timeoutSecs.toString()])

    if (rowCount && rowCount > 0) {
      console.log(`Reaper reset ${rowCount} stuck job(s) to pending`)
    }
  }

  function start(): void {
    running = true
    const tick = async (): Promise<void> => {
      if (!running) return
      try {
        await reap()
      } catch (err) {
        console.error('Reaper error:', err)
      }
      if (running) timer = setTimeout(() => { void tick() }, REAPER_INTERVAL_MS)
    }
    timer = setTimeout(() => { void tick() }, REAPER_INTERVAL_MS)
  }

  function stop(): void {
    running = false
    if (timer) clearTimeout(timer)
  }

  return { start, stop }
}
