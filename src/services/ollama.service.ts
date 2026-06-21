import type { OllamaContentScores, OllamaSimilarArticlesScore } from '../types.ts'
import type { RawFeedItem, SimilarArticleItem } from './truthfulness/reference-sites-crawl.service.ts'

const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://10.13.37.54:30068'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'gemma4'
const OLLAMA_TIMEOUT_MS = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 60_000)

const CATEGORIES = [
  'politics', 'economics', 'science', 'health', 'technology',
  'education', 'law', 'environment', 'world', 'society',
] as const

const PROMPT_PREFIX = `You are a news article classifier. Given the title and summary of a news article, respond with exactly one word: the category that best fits from this list: ${CATEGORIES.join(', ')}, none. Do not explain. Do not add punctuation.

`

function clamp(val: unknown): number | null {
  if (typeof val !== 'number' || isNaN(val)) return null
  return Math.round(Math.min(100, Math.max(0, val)))
}

function extractJson(raw: string): string {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  // Fall back to first [...] array block
  const arrayed = raw.match(/\[[\s\S]*\]/)
  if (arrayed) return arrayed[0]
  // Fall back to first {...} block in case of leading/trailing prose
  const braced = raw.match(/\{[\s\S]*\}/)
  if (braced) return braced[0]
  return raw
}

export class OllamaService {
  async scoreContentAndClassify(title: string, summary: string, content: string): Promise<OllamaContentScores> {
    const categoryList = CATEGORIES.join(', ')
    const prompt = `You are a news article analyst. Analyze the article below and respond with ONLY a valid JSON object — no explanation, no markdown, no code fences.

Schema: {"category":"<one of: ${categoryList}, or null>","biasScore":<0-100>,"languageScore":<0-100>}

category: the single best-fitting category from the list, or null if none fit
biasScore: 0 = completely balanced and unbiased, 100 = heavily one-sided and biased
languageScore: 0 = calm and de-escalating, 50 = neutral reporting, 100 = provocative and inflammatory

Title: ${title}
Summary: ${summary}
Content (excerpt): ${content.slice(0, 500)}`

    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      })
      if (!res.ok) return { category: null, biasScore: null, languageScore: null }
      const data = await res.json() as { response?: string }
      const rawResponse = data.response?.trim() ?? ''
      console.log(`[OllamaService] scoreContentAndClassify raw response: ${rawResponse.slice(0, 300)}`)
      const raw = extractJson(rawResponse)
      const parsed = JSON.parse(raw) as { category?: unknown; biasScore?: unknown; languageScore?: unknown }
      const categoryRaw = typeof parsed.category === 'string' ? parsed.category.toLowerCase().trim() : null
      const category = categoryRaw && (CATEGORIES as readonly string[]).includes(categoryRaw) ? categoryRaw : null
      return { category, biasScore: clamp(parsed.biasScore), languageScore: clamp(parsed.languageScore) }
    } catch (err) {
      console.warn(`[OllamaService] scoreContentAndClassify parse error: ${err instanceof Error ? err.message : err}`)
      return { category: null, biasScore: null, languageScore: null }
    }
  }

  async scoreSimilarArticles(
    title: string,
    articles: Array<{ sourceDomain: string; similarityScore: number; title?: string | null }>,
  ): Promise<OllamaSimilarArticlesScore> {
    const articleList = articles
      .map((a) => `- ${a.sourceDomain} (similarity: ${(a.similarityScore * 100).toFixed(0)}%)${a.title ? `: "${a.title}"` : ''}`)
      .join('\n')

    const prompt = `You are a news credibility analyst. The article titled "${title}" is corroborated by the following sources:

${articleList || '(none)'}

Based on the number, diversity, and apparent quality of the corroborating sources, respond with ONLY a valid JSON object — no explanation, no markdown, no code fences.

Schema: {"similarArticlesScore":<0-100>}

0 = nothing corroborates the story (single obscure source or none)
100 = many high-quality established sources confirm the story`

    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      })
      if (!res.ok) return { similarArticlesScore: null }
      const data = await res.json() as { response?: string }
      const raw = extractJson(data.response?.trim() ?? '')
      const parsed = JSON.parse(raw) as { similarArticlesScore?: unknown }
      return { similarArticlesScore: clamp(parsed.similarArticlesScore) }
    } catch {
      return { similarArticlesScore: null }
    }
  }

  async findSimilarArticles(
    originalTitle: string,
    originalMeta: string,
    originalContent: string,
    candidates: RawFeedItem[],
  ): Promise<SimilarArticleItem[] | null> {
    if (candidates.length === 0) return []

    const OLLAMA_MAX_CANDIDATES = Number(process.env['OLLAMA_MAX_CANDIDATES'] ?? 200)
    const cappedCandidates = candidates.slice(0, OLLAMA_MAX_CANDIDATES)
    if (candidates.length > OLLAMA_MAX_CANDIDATES) {
      console.warn(`[OllamaService] findSimilarArticles: truncating ${candidates.length} candidates to ${OLLAMA_MAX_CANDIDATES}`)
    }

    const candidateList = cappedCandidates
      .map((c, i) => `${i + 1}. [${c.sourceDomain}] "${c.title}" — ${c.description.slice(0, 150)}`)
      .join('\n')

    const prompt = `You are a news similarity analyst. Given an original article and a list of candidates, identify which candidates cover the same news story.

Original: "${originalTitle}" — ${originalMeta}
Content excerpt: ${originalContent.slice(0, 300)}

Candidates:
${candidateList}

Respond with ONLY a valid JSON array. Each element: {"index":<1-based number>,"similarityScore":<0-100>}
Only include candidates with a score above 0. Return an empty array if none are similar.
0 = completely unrelated, 100 = same story reported by a different outlet.`

    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const data = await res.json() as { response?: string }
      const raw = extractJson(data.response?.trim() ?? '')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return null

      const results: SimilarArticleItem[] = []
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue
        const { index, similarityScore } = entry as { index?: unknown; similarityScore?: unknown }
        if (typeof index !== 'number' || typeof similarityScore !== 'number') continue
        if (index < 1 || index > cappedCandidates.length) continue
        const candidate = cappedCandidates[index - 1]
        if (!candidate) continue
        const clamped = clamp(similarityScore)
        const score = clamped === null ? 0 : clamped / 100
        results.push({
          url: candidate.url,
          title: candidate.title || null,
          sourceDomain: candidate.sourceDomain,
          matchedKeywords: [],
          similarityScore: score,
        })
      }
      return results
    } catch (err) {
      console.warn(`[OllamaService] findSimilarArticles failed: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  async classifyTopic(title: string, summary: string): Promise<string | null> {
    const prompt = `${PROMPT_PREFIX}Title: ${title}\nSummary: ${summary}\n\nCategory:`
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const data = await res.json() as { response?: string }
      const raw = data.response?.trim().toLowerCase().replace(/[^a-z]/g, '') ?? ''
      return (CATEGORIES as readonly string[]).includes(raw) ? raw : null
    } catch {
      return null
    }
  }
}
