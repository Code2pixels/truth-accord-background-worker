import cron from 'node-cron'
import { parseExpression } from 'cron-parser'
import { pool } from '../db/client.ts'
import type { ScheduleRow } from '../types/jobs.ts'

interface Scheduler {
  start: () => Promise<void>
  stop: () => void
}

export function buildScheduler(): Scheduler {
  const tasks = new Map<string, cron.ScheduledTask>()

  async function loadAndRegister(): Promise<void> {
    const { rows } = await pool.query<ScheduleRow>(`
      SELECT * FROM worker.schedules WHERE enabled = TRUE
    `)

    for (const schedule of rows) {
      if (tasks.has(schedule.id)) continue
      registerSchedule(schedule)
    }
  }

  function registerSchedule(schedule: ScheduleRow): void {
    const task = cron.schedule(schedule.cron, async () => {
      await fireSchedule(schedule)
    })
    tasks.set(schedule.id, task)
  }

  async function fireSchedule(schedule: ScheduleRow): Promise<void> {
    const nextDate = parseExpression(schedule.cron).next().toDate()

    await pool.query(`
      INSERT INTO worker.jobs (type, payload)
      VALUES ($1, $2)
    `, [schedule.type, schedule.payload])

    await pool.query(`
      UPDATE worker.schedules
      SET last_run_at = NOW(), next_run_at = $1
      WHERE id = $2
    `, [nextDate, schedule.id])
  }

  async function start(): Promise<void> {
    await loadAndRegister()
  }

  function stop(): void {
    for (const task of tasks.values()) {
      task.stop()
    }
    tasks.clear()
  }

  return { start, stop }
}
