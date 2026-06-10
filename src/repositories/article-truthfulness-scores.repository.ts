import { queryOne } from '../db/client.ts'
import type { TruthfulnessScoreRow, TruthfulnessMetrics } from '../types.ts'

export class ArticleTruthfulnessScoresRepository {
  async upsert(
    articleId: string,
    searchSubject: string,
    metrics: TruthfulnessMetrics = {},
  ): Promise<TruthfulnessScoreRow> {
    const row = await queryOne<TruthfulnessScoreRow>(
      `INSERT INTO articles.truthfulness_scores (
        article_id, search_subject,
        factual_accuracy, source_citation_quality, bias_indicator,
        claim_verifiability, language_quality, overall_truthfulness
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (article_id, search_subject) DO UPDATE SET
        factual_accuracy        = COALESCE(EXCLUDED.factual_accuracy,        articles.truthfulness_scores.factual_accuracy),
        source_citation_quality = COALESCE(EXCLUDED.source_citation_quality, articles.truthfulness_scores.source_citation_quality),
        bias_indicator          = COALESCE(EXCLUDED.bias_indicator,          articles.truthfulness_scores.bias_indicator),
        claim_verifiability     = COALESCE(EXCLUDED.claim_verifiability,     articles.truthfulness_scores.claim_verifiability),
        language_quality        = COALESCE(EXCLUDED.language_quality,        articles.truthfulness_scores.language_quality),
        overall_truthfulness    = COALESCE(EXCLUDED.overall_truthfulness,    articles.truthfulness_scores.overall_truthfulness),
        updated_at              = NOW()
      RETURNING *`,
      [
        articleId,
        searchSubject,
        metrics.factualAccuracy ?? null,
        metrics.sourceCitationQuality ?? null,
        metrics.biasIndicator ?? null,
        metrics.claimVerifiability ?? null,
        metrics.languageQuality ?? null,
        metrics.overallTruthfulness ?? null,
      ],
    )
    if (!row) throw new Error(`Failed to upsert truthfulness score for article: ${articleId}`)
    return row
  }
}
