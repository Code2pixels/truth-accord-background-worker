import cron from 'node-cron'
import type { WorkerJobsRepository } from '../repositories/worker-jobs.repository.ts'
import type { WaybackService } from '../services/wayback/wayback.service.ts'
import { stripUtmParams } from '../utils/url.util.ts'

const RECHECK_BATCH_SIZE = 50
const RECHECK_OLDER_THAN_HOURS = 24

export class WaybackRecheckWorker {
  constructor(
    private readonly workerJobsRepo: WorkerJobsRepository,
    private readonly wayback: WaybackService,
  ) {}

  schedule(): void {
    cron.schedule('0 3 * * *', () => void this.runNightlyRecheck())
    console.log('[WaybackRecheck] Scheduled nightly recheck at 3am')
  }

  private async runNightlyRecheck(): Promise<void> {
    console.log('[WaybackRecheck] Starting nightly Wayback recheck')

    const candidates = await this.workerJobsRepo.findFailedWaybackRecheckCandidates(
      RECHECK_BATCH_SIZE,
      RECHECK_OLDER_THAN_HOURS,
    )

    if (candidates.length === 0) {
      console.log('[WaybackRecheck] No candidates')
      return
    }

    console.log(`[WaybackRecheck] Rechecking ${candidates.length} URL(s)`)

    let queued = 0
    for (const { id, url } of candidates) {
      try {
        const snapshot = await this.wayback.getLatestSnapshot(url)
        if (snapshot) {
          await this.workerJobsRepo.create(stripUtmParams(url))
          queued++
          console.log(`[WaybackRecheck] Now available — re-queued: ${url}`)
        }
        await this.workerJobsRepo.markWaybackRecheckQueued(id)
      } catch (err) {
        console.warn(`[WaybackRecheck] Recheck failed for ${url}: ${err instanceof Error ? err.message : err}`)
        await this.workerJobsRepo.markWaybackRecheckQueued(id)
      }
    }

    console.log(`[WaybackRecheck] Done: ${candidates.length} checked, ${queued} re-queued`)
  }
}
