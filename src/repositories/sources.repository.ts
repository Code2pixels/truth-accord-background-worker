import { query } from '../db/client.ts'

export class SourcesRepository {
  async ensureExists(domain: string): Promise<void> {
    await query(
      `INSERT INTO sources.domains (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING`,
      [domain],
    )
  }

  async markPaywall(domain: string): Promise<void> {
    await query(
      `INSERT INTO sources.domains (domain, paywall_detected) VALUES ($1, TRUE)
       ON CONFLICT (domain) DO UPDATE SET paywall_detected = TRUE`,
      [domain],
    )
  }

  async markUnarchivable(domain: string): Promise<void> {
    await query(
      `INSERT INTO sources.domains (domain, is_unarchivable) VALUES ($1, TRUE)
       ON CONFLICT (domain) DO UPDATE SET is_unarchivable = TRUE`,
      [domain],
    )
  }

  /**
   * Recomputes the per-source approved-article counts read by the API. Uses
   * CONCURRENTLY so reads against the view are never blocked during refresh
   * (requires the unique index defined in the matview migration).
   */
  async refreshArticleCounts(): Promise<void> {
    await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY sources.article_counts`)
  }
}
