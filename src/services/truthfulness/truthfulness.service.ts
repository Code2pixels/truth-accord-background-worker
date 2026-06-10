import { getReferenceTrustScore } from './reference-sites.const.ts'
import type { ReferenceSitesCrawlService } from './reference-sites-crawl.service.ts'
import type { TruthfulnessMetrics } from '../../types.ts'

interface TruthfulnessInput {
  title: string | null
  author: string | null
  metaDescription: string | null
  wordCount: number | null
  content?: string | null
  url?: string
  sourceDomain?: string | null
}

export class TruthfulnessService {
  constructor(private readonly referenceSitesCrawl: ReferenceSitesCrawlService) {}

  async computeScores(input: TruthfulnessInput, precomputedMatchCount?: number): Promise<TruthfulnessMetrics> {
    const title = input.title?.trim() ?? ''
    const meta = input.metaDescription?.trim() ?? ''
    const matchCount =
      precomputedMatchCount !== undefined
        ? precomputedMatchCount
        : title || meta ? await this.referenceSitesCrawl.getMatchingArticleCount(title, meta) : 0

    const factualAccuracy = this.scoreFactualAccuracy(input)
    const sourceCitationQuality = this.scoreSourceCitationQuality(input, matchCount)
    const biasIndicator = this.scoreBiasIndicator()
    const claimVerifiability = this.scoreClaimVerifiability(input)
    const languageQuality = this.scoreLanguageQuality(input)
    const overallTruthfulness = this.scoreOverall(factualAccuracy, sourceCitationQuality, biasIndicator, claimVerifiability, languageQuality)

    return { factualAccuracy, sourceCitationQuality, biasIndicator, claimVerifiability, languageQuality, overallTruthfulness }
  }

  private scoreFactualAccuracy(input: TruthfulnessInput): number {
    const words = input.wordCount ?? 0
    const hasBody = words >= 100
    const hasMeta = Boolean(input.metaDescription?.trim())
    const siteTrust = getReferenceTrustScore(input.sourceDomain)
    if (siteTrust != null) {
      let score = siteTrust
      if (hasBody && hasMeta) score = Math.min(1, score + 0.05)
      else if (hasBody) score = Math.min(1, score + 0.02)
      return Math.round(score * 100) / 100
    }
    if (hasBody && hasMeta) return 0.65
    if (hasBody) return 0.55
    return 0.45
  }

  private scoreSourceCitationQuality(input: TruthfulnessInput, matchCount: number): number {
    const hasMeta = Boolean(input.metaDescription?.trim())
    const hasAuthor = Boolean(input.author?.trim())
    let score: number
    if (matchCount >= 5) score = 0.75 + (hasMeta ? 0.08 : 0) + (hasAuthor ? 0.05 : 0)
    else if (matchCount >= 2) score = 0.68 + (hasMeta ? 0.05 : 0) + (hasAuthor ? 0.04 : 0)
    else if (matchCount >= 1) score = 0.6 + (hasMeta ? 0.05 : 0) + (hasAuthor ? 0.03 : 0)
    else if (hasMeta && hasAuthor) score = 0.7
    else if (hasMeta) score = 0.6
    else score = 0.5
    return Math.round(Math.min(1, score) * 100) / 100
  }

  private scoreBiasIndicator(): number { return 0.2 }

  private scoreClaimVerifiability(input: TruthfulnessInput): number {
    const words = input.wordCount ?? 0
    if (words >= 300) return 0.6
    if (words >= 100) return 0.55
    return 0.5
  }

  private scoreLanguageQuality(input: TruthfulnessInput): number {
    const hasTitle = Boolean(input.title?.trim())
    const words = input.wordCount ?? 0
    const hasBody = words >= 100
    if (hasTitle && hasBody) return 0.7
    if (hasTitle) return 0.6
    return 0.5
  }

  private scoreOverall(factual: number, citation: number, bias: number, claim: number, language: number): number {
    return Math.round(((factual + citation + (1 - bias) + claim + language) / 5) * 100) / 100
  }
}
