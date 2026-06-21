import type { ScraperService } from '../services/scraper/scraper.service.ts'
import type { WaybackService } from '../services/wayback/wayback.service.ts'
import type { ArticlesService } from '../services/articles.service.ts'
import type { WorkerJobsRepository } from '../repositories/worker-jobs.repository.ts'
import type { ArticleTruthfulnessScoresRepository } from '../repositories/article-truthfulness-scores.repository.ts'
import type { SimilarArticlesRepository } from '../repositories/similar-articles.repository.ts'
import type { TruthfulnessService } from '../services/truthfulness/truthfulness.service.ts'
import type { ReferenceSitesCrawlService } from '../services/truthfulness/reference-sites-crawl.service.ts'
import type { SourcesRepository } from '../repositories/sources.repository.ts'
import type { ScrapeJob } from '../types.ts'
import type { OllamaService } from '../services/ollama.service.ts'
import { classifyTopic } from '../services/topic-classifier.ts'

export class ScrapeWorker {
  private isRunning = false
  private timer: NodeJS.Timeout | null = null
  private readonly concurrency: number
  private readonly maxRetries: number
  private readonly minSimilarityScore: number

  constructor(
    private readonly scraper: ScraperService,
    private readonly wayback: WaybackService,
    private readonly articles: ArticlesService,
    private readonly workerJobsRepo: WorkerJobsRepository,
    private readonly truthfulnessScoresRepo: ArticleTruthfulnessScoresRepository,
    private readonly similarArticlesRepo: SimilarArticlesRepository,
    private readonly truthfulness: TruthfulnessService,
    private readonly referenceSitesCrawl: ReferenceSitesCrawlService,
    private readonly sourcesRepo: SourcesRepository,
    private readonly ollama: OllamaService,
  ) {
    this.concurrency = Number(process.env['QUEUE_CONCURRENCY'] ?? 3)
    this.maxRetries = Number(process.env['MAX_RETRIES'] ?? 3)
    const parsedThreshold = Number(process.env['SIMILAR_ARTICLE_MIN_SCORE'] ?? 0.25)
    this.minSimilarityScore = Number.isFinite(parsedThreshold) && parsedThreshold >= 0 && parsedThreshold <= 1
      ? parsedThreshold
      : 0.25
    if (!Number.isFinite(parsedThreshold) || parsedThreshold < 0 || parsedThreshold > 1) {
      console.warn(`[ScrapeWorker] SIMILAR_ARTICLE_MIN_SCORE "${process.env['SIMILAR_ARTICLE_MIN_SCORE']}" is invalid — using default 0.25`)
    }
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.poll(), intervalMs)
    console.log(`[ScrapeWorker] Started — polling every ${intervalMs}ms, concurrency=${this.concurrency}, maxRetries=${this.maxRetries}`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    console.log('[ScrapeWorker] Stopped')
  }

  private async poll(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      const reset = await this.workerJobsRepo.resetStuckRunning(5)
      if (reset > 0) console.log(`[ScrapeWorker] Reset ${reset} stuck job(s) back to pending`)

      const jobs = await this.workerJobsRepo.claimPending(this.concurrency)
      if (jobs.length === 0) return

      console.log(`[ScrapeWorker] Claimed ${jobs.length} job(s)`)
      await Promise.all(jobs.map((job) => this.processJob(job)))
    } catch (err) {
      console.error('[ScrapeWorker] Poll error:', err instanceof Error ? err.message : err)
    } finally {
      this.isRunning = false
    }
  }

  private async processJob(job: ScrapeJob): Promise<void> {
    const { id, url } = job
    const t0 = Date.now()
    console.log(`[Job ${id}] ── START ──────────────────────────────`)
    console.log(`[Job ${id}] URL:         ${url}`)
    console.log(`[Job ${id}] Search term: ${job.search_term ?? '(none)'}`)
    console.log(`[Job ${id}] Attempt:     ${job.attempts + 1}/${job.max_attempts}`)

    try {
      // Step 1: Scrape
      console.log(`[Job ${id}] [1/7] Fetching URL...`)
      let scraped = await this.scraper.scrape(url)
      const sourceDomain = new URL(url).hostname
      console.log(`[Job ${id}]       title:       ${scraped.title ?? '(none)'}`)
      console.log(`[Job ${id}]       author:      ${scraped.author ?? '(none)'}`)
      console.log(`[Job ${id}]       word count:  ${scraped.wordCount ?? 0}`)
      console.log(`[Job ${id}]       published:   ${scraped.publishedAt ?? '(unknown)'}`)
      console.log(`[Job ${id}]       paywall:     ${scraped.paywallDetected}`)

      // Step 2: Paywall / Wayback fallback
      if (scraped.paywallDetected) {
        console.warn(`[Job ${id}] [2/7] Paywall detected — marking ${sourceDomain} and checking Wayback Machine...`)
        await this.sourcesRepo.markPaywall(sourceDomain)

        const snapshot = await this.wayback.getLatestSnapshot(url)
        if (snapshot) {
          console.log(`[Job ${id}]       Wayback snapshot found: ${snapshot.url} (${snapshot.timestamp})`)
          scraped = await this.scraper.scrape(snapshot.url, { forceStatic: true })
          scraped.isArchived = true
          scraped.snapshotTimestamp = snapshot.timestamp
          scraped.url = url
          console.log(`[Job ${id}]       Re-scraped via archive — word count: ${scraped.wordCount ?? 0}`)
        } else {
          console.warn(`[Job ${id}]       No Wayback snapshot available — marking unarchivable, failing job`)
          await this.sourcesRepo.markUnarchivable(sourceDomain)
          await this.workerJobsRepo.failWithRetry(id, 'Paywalled — no archive snapshot found')
          console.log(`[Job ${id}] ── FAILED (paywall, no archive) [${Date.now() - t0}ms] ──`)
          return
        }
      } else {
        console.log(`[Job ${id}] [2/7] No paywall detected`)
      }

      // Step 3: Ensure source domain is tracked
      console.log(`[Job ${id}] [3/7] Ensuring source domain: ${sourceDomain}`)
      await this.sourcesRepo.ensureExists(sourceDomain)

      // Step 4: Topic filter — Ollama primary, keyword classifier as category fallback
      const urlSlug = new URL(url).pathname.replace(/[-/]/g, ' ')
      const topicText = [urlSlug, scraped.title, scraped.metaDescription, scraped.content].filter(Boolean).join(' ')
      console.log(`[Job ${id}] [4/7] Scoring and classifying via Ollama...`)
      const ollamaContent = await this.ollama.scoreContentAndClassify(
        scraped.title ?? '',
        scraped.metaDescription ?? '',
        scraped.content ?? '',
      )
      console.log(`[Job ${id}]       [Ollama] category: ${ollamaContent.category ?? 'null'} | biasScore: ${ollamaContent.biasScore ?? 'null'} | languageScore: ${ollamaContent.languageScore ?? 'null'}`)
      const articleCategory = ollamaContent.category ?? classifyTopic(topicText)
      if (articleCategory) {
        console.log(`[Job ${id}] [4/7] Topic check passed — category: ${articleCategory}${ollamaContent.category ? ' (Ollama)' : ' (keyword)'}`)
      } else {
        console.log(`[Job ${id}] [4/7] Off-topic — skipping insert`)
        await this.workerJobsRepo.updateStatus(id, 'completed')
        console.log(`[Job ${id}] ── SKIPPED (off-topic) [${Date.now() - t0}ms] ──`)
        return
      }

      // Step 5: Upsert article
      console.log(`[Job ${id}] [5/7] Upserting article record...`)
      const hasTitle = !!(scraped.title?.trim()) && scraped.title.trim().toLowerCase() !== sourceDomain.replace(/^www\./, '').split('.')[0]
      const hasDescription = !!(scraped.metaDescription?.trim())
      const articleStatus = hasTitle && hasDescription ? 'approved' : 'pending'
      if (articleStatus === 'pending') {
        console.warn(`[Job ${id}]       Incomplete metadata (title=${hasTitle}, description=${hasDescription}) — setting status=pending`)
      }
      const article = await this.articles.upsert({
        url: scraped.url,
        title: scraped.title,
        author: scraped.author,
        publishedAt: scraped.publishedAt,
        sourceDomain,
        isArchived: scraped.isArchived,
        snapshotTimestamp: scraped.snapshotTimestamp,
        metaDescription: scraped.metaDescription,
        wordCount: scraped.wordCount,
        status: articleStatus,
        category: articleCategory,
      })
      console.log(`[Job ${id}]       article.id: ${article.id}`)

      // Step 6: Similar articles — Ollama primary, heuristic fallback
      const title = scraped.title?.trim() ?? ''
      const metaDesc = scraped.metaDescription?.trim() ?? ''
      console.log(`[Job ${id}] [6/7] Finding similar articles (Ollama primary, heuristic fallback)...`)

      const rawCandidates = await this.referenceSitesCrawl.getAllFeedItems()
      console.log(`[Job ${id}]       raw candidates from feeds: ${rawCandidates.length}`)

      let similarItems = await this.ollama.findSimilarArticles(title, metaDesc, scraped.content ?? '', rawCandidates)

      if (similarItems === null) {
        console.warn(`[Job ${id}]       Ollama unavailable — falling back to heuristic matching`)
        const matchResult = await this.referenceSitesCrawl.getMatchingArticles(title, metaDesc, scraped.content ?? '')
        similarItems = matchResult.items
      }

      const normalizedSourceDomain = sourceDomain.replace(/^www\./, '')
      const itemsToSave = similarItems.filter((it) =>
        (it.similarityScore ?? 0) >= this.minSimilarityScore && it.sourceDomain !== normalizedSourceDomain,
      )
      console.log(`[Job ${id}]       matches found: ${similarItems.length}, above threshold (${this.minSimilarityScore}): ${itemsToSave.length}`)
      if (itemsToSave.length > 0) {
        for (const it of itemsToSave) {
          console.log(`[Job ${id}]         • [${((it.similarityScore ?? 0) * 100).toFixed(1)}%] ${it.sourceDomain} — ${it.title ?? it.url}`)
        }
      }

      // Ollama: score similar articles corroboration
      const ollamaSimilar = itemsToSave.length > 0
        ? await this.ollama.scoreSimilarArticles(scraped.title ?? '', itemsToSave)
        : { similarArticlesScore: null }
      console.log(`[Job ${id}]       [Ollama] similarArticlesScore: ${ollamaSimilar.similarArticlesScore ?? 'null'}`)

      // If no similar articles found, requeue until max_attempts then mark unverified
      if (itemsToSave.length === 0) {
        const isLastAttempt = job.attempts + 1 >= job.max_attempts
        if (isLastAttempt) {
          await this.articles.markUnverified(article.id)
          await this.workerJobsRepo.updateStatus(id, 'dead')
          console.log(`[Job ${id}] ── UNVERIFIED (no similar articles after ${job.max_attempts} attempts) [${Date.now() - t0}ms] ──`)
        } else {
          await this.workerJobsRepo.failWithRetry(id, 'No similar articles found')
          console.log(`[Job ${id}] ── REQUEUED (no similar articles, attempt ${job.attempts + 1}/${job.max_attempts}) [${Date.now() - t0}ms] ──`)
        }
        return
      }

      // Step 7: Truthfulness scores — Ollama primary, heuristic fallback
      const hasOllamaScores = ollamaContent.biasScore != null
        || ollamaContent.languageScore != null
        || ollamaSimilar.similarArticlesScore != null
      let truthfulnessMetrics
      if (hasOllamaScores) {
        console.log(`[Job ${id}] [7/7] Persisting Ollama scores...`)
        const toDecimal = (v: number | null) => v != null ? v / 100 : null
        const biasIndicator = toDecimal(ollamaContent.biasScore)
        const languageQuality = toDecimal(ollamaContent.languageScore)
        const sourceCitationQuality = toDecimal(ollamaSimilar.similarArticlesScore)
        const signals = [biasIndicator, languageQuality, sourceCitationQuality].filter((v): v is number => v != null)
        const overallTruthfulness = signals.length > 0 ? signals.reduce((a, b) => a + b, 0) / signals.length : null
        truthfulnessMetrics = { biasIndicator, languageQuality, sourceCitationQuality, overallTruthfulness }
        console.log(`[Job ${id}]       bias_indicator:          ${biasIndicator}`)
        console.log(`[Job ${id}]       language_quality:        ${languageQuality}`)
        console.log(`[Job ${id}]       source_citation_quality: ${sourceCitationQuality}`)
        console.log(`[Job ${id}]       overall_truthfulness:    ${overallTruthfulness}`)
      } else {
        console.log(`[Job ${id}] [7/7] Ollama unavailable — falling back to heuristic scoring...`)
        truthfulnessMetrics = await this.truthfulness.computeScores({
          title: scraped.title,
          author: scraped.author,
          metaDescription: scraped.metaDescription,
          wordCount: scraped.wordCount,
          content: scraped.content,
          url: scraped.url,
          sourceDomain,
        }, itemsToSave.length)
        console.log(`[Job ${id}]       factual_accuracy:        ${truthfulnessMetrics.factualAccuracy}`)
        console.log(`[Job ${id}]       source_citation_quality: ${truthfulnessMetrics.sourceCitationQuality}`)
        console.log(`[Job ${id}]       bias_indicator:          ${truthfulnessMetrics.biasIndicator}`)
        console.log(`[Job ${id}]       claim_verifiability:     ${truthfulnessMetrics.claimVerifiability}`)
        console.log(`[Job ${id}]       language_quality:        ${truthfulnessMetrics.languageQuality}`)
        console.log(`[Job ${id}]       overall_truthfulness:    ${truthfulnessMetrics.overallTruthfulness}`)
      }

      // Persist
      await this.truthfulnessScoresRepo.upsert(article.id, job.search_term ?? 'unknown', truthfulnessMetrics)
      await this.similarArticlesRepo.replaceForArticle(article.id, itemsToSave)
      await this.workerJobsRepo.updateStatus(id, 'completed')

      const elapsed = Date.now() - t0
      console.log(`[Job ${id}] ── COMPLETED [${elapsed}ms] ──────────────`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      console.error(`[Job ${id}] ── ERROR ──────────────────────────────`)
      console.error(`[Job ${id}] ${message}`)
      if (stack) console.error(`[Job ${id}] ${stack}`)
      await this.workerJobsRepo.failWithRetry(id, message)
      console.log(`[Job ${id}] ── FAILED (attempt ${job.attempts + 1}/${job.max_attempts}) [${Date.now() - t0}ms] ──`)
    }
  }
}
