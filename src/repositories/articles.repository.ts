import { queryOne } from '../db/client.ts'
import type { ArticleRow, CreateArticleInput } from '../types.ts'

export class ArticlesRepository {
  async upsert(input: CreateArticleInput): Promise<ArticleRow> {
    const sourceDomain = input.sourceDomain ?? new URL(input.url).hostname
    const sourceUrl = (() => { try { const u = new URL(input.url); return `${u.protocol}//${u.host}` } catch { return input.url } })()

    const row = await queryOne<ArticleRow>(
      `INSERT INTO articles.records (
        url, title, summary, authored_by, source, source_url,
        published_at, is_archived, snapshot_timestamp, word_count, status, category
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (url) DO UPDATE SET
        title              = EXCLUDED.title,
        summary            = EXCLUDED.summary,
        authored_by        = EXCLUDED.authored_by,
        source             = EXCLUDED.source,
        source_url         = EXCLUDED.source_url,
        published_at       = EXCLUDED.published_at,
        is_archived        = EXCLUDED.is_archived,
        snapshot_timestamp = EXCLUDED.snapshot_timestamp,
        word_count         = EXCLUDED.word_count,
        category           = EXCLUDED.category,
        recorded_at        = NOW()
      RETURNING *`,
      [
        input.url,
        input.title ?? '',
        input.metaDescription ?? '',
        input.author ?? '',
        sourceDomain,
        sourceUrl,
        input.publishedAt ?? null,
        input.isArchived,
        input.snapshotTimestamp ?? null,
        input.wordCount ?? null,
        input.status ?? 'pending',
        input.category ?? null,
      ],
    )
    if (!row) throw new Error(`Failed to upsert article: ${input.url}`)
    return row
  }
}
