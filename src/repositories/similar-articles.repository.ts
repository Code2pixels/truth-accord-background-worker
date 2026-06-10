import { query } from '../db/client.ts'

export interface SimilarArticleInput {
  url: string
  title?: string | null
  sourceDomain: string
  matchedKeywords: string[]
  similarityScore: number
}

export class SimilarArticlesRepository {
  async replaceForArticle(articleId: string, items: SimilarArticleInput[]): Promise<number> {
    if (items.length === 0) return 0

    const byUrl = new Map<string, SimilarArticleInput>()
    for (const it of items) {
      const existing = byUrl.get(it.url)
      if (!existing || (it.similarityScore ?? 0) > (existing.similarityScore ?? 0)) {
        byUrl.set(it.url, it)
      }
    }
    const deduped = [...byUrl.values()]

    await query(`DELETE FROM articles.similar_articles WHERE article_id = $1`, [articleId])

    const values: unknown[] = []
    const placeholders: string[] = []
    deduped.forEach((it, idx) => {
      const base = idx * 7 + 1
      const sourceUrl = (() => { try { return `https://${it.sourceDomain}` } catch { return '' } })()
      placeholders.push(`($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`)
      values.push(
        articleId,
        it.url,
        it.title ?? null,
        it.sourceDomain,
        sourceUrl,
        it.matchedKeywords.length > 0 ? it.matchedKeywords : null,
        it.similarityScore ?? null,
      )
    })

    await query(
      `INSERT INTO articles.similar_articles (article_id, url, title, source, source_url, matched_keywords, similarity_score)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (article_id, url) DO UPDATE SET
         title            = EXCLUDED.title,
         source           = EXCLUDED.source,
         source_url       = EXCLUDED.source_url,
         matched_keywords = EXCLUDED.matched_keywords,
         similarity_score = EXCLUDED.similarity_score`,
      values,
    )
    return deduped.length
  }
}
