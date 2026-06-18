import type { ArticlesRepository } from '../repositories/articles.repository.ts'
import type { CreateArticleInput } from '../types.ts'

export interface ArticleResult {
  id: string
  url: string
}

export class ArticlesService {
  constructor(private readonly articlesRepo: ArticlesRepository) {}

  async upsert(input: CreateArticleInput): Promise<ArticleResult> {
    const row = await this.articlesRepo.upsert(input)
    return { id: row.id, url: row.url }
  }

  async markUnverified(id: string): Promise<void> {
    await this.articlesRepo.markUnverified(id)
  }
}
