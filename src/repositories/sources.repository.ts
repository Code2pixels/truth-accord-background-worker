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
}
