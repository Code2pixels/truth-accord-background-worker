export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead'

export interface ScrapeJob {
  id: string
  url: string
  search_term: string | null
  status: JobStatus
  attempts: number
  max_attempts: number
  last_error: string | null
}

export interface ArticleRow {
  id: string
  url: string
  title: string
  summary: string
  authored_by: string
  source: string
  source_url: string
  status: string
  category: string | null
  published_at: string | null
  is_archived: boolean
  snapshot_timestamp: string | null
  word_count: number | null
  recorded_at: string
}

export interface TruthfulnessScoreRow {
  id: string
  article_id: string
  search_subject: string
  factual_accuracy: number | null
  source_citation_quality: number | null
  bias_indicator: number | null
  claim_verifiability: number | null
  language_quality: number | null
  overall_truthfulness: number | null
  created_at: string
  updated_at: string
}

export interface SimilarArticleRow {
  id: string
  article_id: string
  url: string
  title: string | null
  source: string
  source_url: string
  matched_keywords: string[] | null
  similarity_score: number | null
  created_at: string
}

export interface SourceDomainRow {
  domain: string
  paywall_detected: boolean
  is_unarchivable: boolean
  created_at: string
}

export interface TruthfulnessMetrics {
  factualAccuracy?: number | null
  sourceCitationQuality?: number | null
  biasIndicator?: number | null
  claimVerifiability?: number | null
  languageQuality?: number | null
  overallTruthfulness?: number | null
}

export interface CreateArticleInput {
  url: string
  title: string | null
  author: string | null
  publishedAt: string | null
  sourceDomain: string | null
  isArchived: boolean
  snapshotTimestamp: string | null
  metaDescription: string | null
  wordCount: number | null
  status?: string
  category?: string | null
}

export interface QueueStats {
  pending: number
  running: number
  completed: number
  failed: number
  dead: number
}
