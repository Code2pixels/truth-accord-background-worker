import cron from 'node-cron'
import type { WorkerJobsRepository } from '../repositories/worker-jobs.repository.ts'
import type { WaybackService } from '../services/wayback/wayback.service.ts'
import { stripUtmParams } from '../utils/url.util.ts'
import { bad, dim, ok, tag, warn } from '../utils/log.util.ts'

const RECHECK_BATCH_SIZE = 50
const RECHECK_OLDER_THAN_HOURS = 24

export class WaybackRecheckWorker {
  constructor(
    private readonly workerJobsRepo: WorkerJobsRepository,
    private readonly wayback: WaybackService,
  ) {}

  schedule(): void {
    cron.schedule('0 3 * * *', () => void this.runNightlyRecheck())
    console.log(`${tag('WaybackRecheck')} Scheduled nightly recheck at 3am`)
  }

  private async runNightlyRecheck(): Promise<void> {
    try {
      console.log(`${tag('WaybackRecheck')} Starting nightly Wayback recheck`)

      const candidates = await this.workerJobsRepo.findFailedWaybackRecheckCandidates(
        RECHECK_BATCH_SIZE,
        RECHECK_OLDER_THAN_HOURS,
      )

      if (candidates.length === 0) {
        console.log(`${tag('WaybackRecheck')} ${dim('No candidates')}`)
        return
      }

      console.log(`${tag('WaybackRecheck')} Rechecking ${candidates.length} URL(s)`)

      let queued = 0
      for (const { id, url } of candidates) {
        try {
          const snapshot = await this.wayback.getLatestSnapshot(url)
          if (snapshot) {
            await this.workerJobsRepo.create(stripUtmParams(url))
            queued++
            console.log(`${tag('WaybackRecheck')} ${ok('Now available — re-queued')}: ${url}`)
          }
          await this.workerJobsRepo.markWaybackRecheckQueued(id)
        } catch (err) {
          console.warn(`${tag('WaybackRecheck')} ${warn(`Recheck failed for ${url}`)}: ${err instanceof Error ? err.message : err}`)
          await this.workerJobsRepo.markWaybackRecheckQueued(id)
        }
      }

      console.log(`${tag('WaybackRecheck')} Done: ${candidates.length} checked, ${ok(String(queued))} re-queued`)
    } catch (err) {
      console.error(`${tag('WaybackRecheck')} ${bad('Nightly recheck failed:')}`, err instanceof Error ? err.message : err)
    }
  }
}
