import fs from 'node:fs'
import { parse } from 'csv-parse'
import type { JobHandler } from '../types/jobs.ts'

export const csvIngestHandler: JobHandler<'csv_ingest'> = {
  type: 'csv_ingest',
  maxAttempts: 3,
  timeoutMs: 5 * 60_000, // 5 minutes for large files

  async run(payload) {
    const delimiter = payload.delimiter ?? ','

    await new Promise<void>((resolve, reject) => {
      let rowCount = 0

      const stream = fs.createReadStream(payload.filePath)
        .pipe(parse({
          delimiter,
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }))

      stream.on('data', (row: Record<string, string>) => {
        rowCount++
        // TODO: replace this log with actual ingestion logic (e.g. DB insert)
        if (rowCount <= 3) {
          console.log(`[csv_ingest] row ${rowCount}:`, row)
        }
      })

      stream.on('end', () => {
        console.log(`[csv_ingest] ${payload.filePath}: processed ${rowCount} rows`)
        resolve()
      })

      stream.on('error', reject)
    })
  },
}
