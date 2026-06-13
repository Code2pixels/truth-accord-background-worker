import { query } from '../db/client.ts'

export interface ReferenceSiteRecord {
  domain: string
  trustScore: number
  feedUrl: string
}

export class ReferenceSitesRepository {
  async findAll(): Promise<ReferenceSiteRecord[]> {
    const rows = await query<{ url: string; trust_score: number; rss_url: string }>(
      `SELECT url, trust_score, rss_url
       FROM sources.records
       WHERE trust_score IS NOT NULL AND rss_url IS NOT NULL AND is_active = TRUE`,
    )
    return rows.map((r) => ({
      domain: new URL(r.url).hostname.replace(/^www\./, ''),
      trustScore: Number(r.trust_score),
      feedUrl: r.rss_url,
    }))
  }
}
