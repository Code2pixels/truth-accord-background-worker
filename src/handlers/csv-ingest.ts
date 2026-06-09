import fs from 'node:fs'
import { parse } from 'csv-parse'
import { insertArticle } from '../lib/articles.ts'
import type { JobHandler } from '../types/jobs.ts'

interface ArticleRow {
  url?: string
  title?: string
  summary?: string
  authored_by?: string
  source?: string
  source_url?: string
  [key: string]: string | undefined
}

export const csvIngestHandler: JobHandler<'csv_ingest'> = {
  type: 'csv_ingest',
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,

  async run(payload) {
    const delimiter = payload.delimiter ?? ','
    let inserted = 0
    let skipped = 0

    await new Promise<void>((resolve, reject) => {
      const pending: Promise<void>[] = []

      const stream = fs.createReadStream(payload.filePath)
        .pipe(parse({
          delimiter,
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }))

      stream.on('data', (row: ArticleRow) => {
        const url = row['url'] ?? ''
        const title = row['title'] ?? ''

        if (!url || !title) {
          skipped++
          return
        }

        const origin = (() => {
          try { return new URL(url).origin } catch { return url }
        })()
        const hostname = (() => {
          try { return new URL(url).hostname } catch { return url }
        })()

        pending.push(
          insertArticle({
            url,
            title,
            summary: row['summary'] ?? '',
            authored_by: row['authored_by'] ?? hostname,
            source: row['source'] ?? hostname,
            source_url: row['source_url'] ?? origin,
          }).then(() => { inserted++ })
        )
      })

      stream.on('end', () => {
        Promise.all(pending).then(() => resolve()).catch(reject)
      })

      stream.on('error', reject)
    })

    console.log(`[csv_ingest] ${payload.filePath}: inserted=${inserted} skipped=${skipped}`)
  },
}
