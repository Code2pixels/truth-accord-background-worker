import type { WaybackSnapshot, WaybackAvailabilityResponse, CdxRecord } from './wayback.interfaces.ts'

const AVAILABILITY_API = 'https://archive.org/wayback/available'
const CDX_API = 'https://web.archive.org/cdx/search/cdx'
const MAX_RETRIES = 3
const RETRY_BASE_MS = 1_000

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await globalThis.fetch(url, { signal: AbortSignal.timeout(15_000) })
    } catch (err) {
      const isLast = attempt === retries
      if (isLast) throw err
      const delay = RETRY_BASE_MS * 2 ** attempt
      console.warn(`[WaybackService] Fetch failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms:`, err instanceof Error ? err.message : err)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error('unreachable')
}

export class WaybackService {
  async getLatestSnapshot(url: string): Promise<WaybackSnapshot | null> {
    try {
      const params = new URLSearchParams({ url })
      const res = await fetchWithRetry(`${AVAILABILITY_API}?${params}`)
      const data = await res.json() as WaybackAvailabilityResponse
      const closest = data.archived_snapshots?.closest
      if (!closest?.available) return null
      return {
        url: closest.url,
        timestamp: this.parseTimestamp(closest.timestamp),
        originalUrl: url,
        statusCode: parseInt(closest.status, 10) || null,
      }
    } catch {
      return null
    }
  }

  async getSnapshotInRange(url: string, fromDate: string, toDate: string): Promise<WaybackSnapshot | null> {
    try {
      const params = new URLSearchParams({
        url, output: 'json',
        fl: 'urlkey,timestamp,original,mimetype,statuscode,digest,length',
        filter: 'statuscode:200', from: fromDate, to: toDate, limit: '1', collapse: 'timestamp:8',
      })
      const res = await fetchWithRetry(`${CDX_API}?${params}`)
      const rows = await res.json() as string[][]
      if (!Array.isArray(rows) || rows.length < 2) return null
      const [headers, firstRecord] = rows
      if (!headers || !firstRecord) return null
      const record = Object.fromEntries(headers.map((h, i) => [h, firstRecord[i]])) as unknown as CdxRecord
      return {
        url: `https://web.archive.org/web/${record.timestamp}/${record.original}`,
        timestamp: this.parseTimestamp(record.timestamp),
        originalUrl: url,
        statusCode: parseInt(record.statuscode, 10) || null,
      }
    } catch {
      return null
    }
  }

  private parseTimestamp(ts: string): string {
    return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`
  }
}
