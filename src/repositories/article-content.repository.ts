import { query } from '../db/client.ts'
import type { OutboundLink } from '../services/scraper/scraper.interfaces.ts'

export class ArticleContentRepository {
  async upsert(articleId: string, text: string, links: OutboundLink[]): Promise<void> {
    await query(
      `INSERT INTO articles.content (article_id, text, links, char_count, fetched_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (article_id) DO UPDATE SET
         text       = EXCLUDED.text,
         links      = EXCLUDED.links,
         char_count = EXCLUDED.char_count,
         fetched_at = NOW()`,
      [articleId, text, JSON.stringify(links), text.length],
    )
  }
}
