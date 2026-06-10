import { query } from '../db/client.ts'

export interface RssSource {
  id: string
  name: string
  url: string
  rss_url: string
}

export class RssSourcesRepository {
  async findAllActive(): Promise<RssSource[]> {
    return query<RssSource>(
      `SELECT id, name, url, rss_url FROM sources.records WHERE is_active = TRUE ORDER BY name ASC`,
    )
  }
}
