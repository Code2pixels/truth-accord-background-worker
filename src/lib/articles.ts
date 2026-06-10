import { pool } from '../db/client.ts'

export interface ArticleInsert {
  url: string
  title: string
  summary: string
  authored_by: string
  source: string
  source_url: string
  status?: string
}

export async function insertArticle(article: ArticleInsert): Promise<string> {
  const status = article.status ?? 'pending'
  const { rows } = await pool.query<{ id: string }>(`
    INSERT INTO articles.records (url, title, summary, authored_by, source, source_url, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [article.url, article.title, article.summary, article.authored_by, article.source, article.source_url, status])

  return rows[0]!.id
}

export function extractHtmlMeta(html: string, pageUrl: string): ArticleInsert {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = titleMatch?.[1]?.trim() ?? ''

  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
  const summary = descMatch?.[1]?.trim() ?? ''

  const authorMatch = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i)

  const origin = new URL(pageUrl).origin
  const hostname = new URL(pageUrl).hostname
  const authored_by = authorMatch?.[1]?.trim() ?? hostname

  return { url: pageUrl, title, summary, authored_by, source: hostname, source_url: origin }
}
