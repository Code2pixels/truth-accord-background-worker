import type { OllamaContentScores, OllamaSimilarArticlesScore } from '../types.ts'
import type { RawFeedItem, SimilarArticleItem } from './truthfulness/reference-sites-crawl.service.ts'

const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://10.13.37.54:30068'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'gemma4'
const OLLAMA_TIMEOUT_MS = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 60_000)
const OLLAMA_NUM_CTX = positiveIntEnv('OLLAMA_NUM_CTX', 8192)
const OLLAMA_EMBED_MODEL = process.env['OLLAMA_EMBED_MODEL'] ?? 'nomic-embed-text'

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

export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[OllamaService] ${name}="${raw}" is invalid — using default ${fallback}`)
    return fallback
  }
  return Math.floor(n)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    magA += av * av
    magB += bv * bv
  }
  if (magA === 0 || magB === 0) return 0
  // Guard against NaN from malformed (non-numeric) embedding rows — keeps sort order
  // stable and prevents NaN leaking into similarityScore.
  const result = dot / (Math.sqrt(magA) * Math.sqrt(magB))
  return Number.isFinite(result) ? result : 0
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

  private async scoreTopCandidates(
    originalTitle: string,
    originalMeta: string,
    originalContent: string,
    candidates: RawFeedItem[],
  ): Promise<SimilarArticleItem[] | null> {
    if (candidates.length === 0) return []

    const candidateList = candidates
      .map((c, i) => `${i + 1}. [${c.sourceDomain}] "${c.title}" — ${c.description.slice(0, 150)}`)
      .join('\n')

    const prompt = `You are a news similarity analyst. Given an original article and a list of candidates, identify which candidates cover the same news story.

Original: "${originalTitle}" — ${originalMeta}
Content excerpt: ${originalContent.slice(0, 300)}

Candidates:
${candidateList}

Respond with ONLY a valid JSON array — no explanation, no markdown, no code fences. Each element: {"index":<1-based number>,"similarityScore":<0-100>}
Only include candidates with a score above 0. Return an empty array if none are similar.
0 = completely unrelated, 100 = same story reported by a different outlet.`

    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: 'json', options: { num_ctx: OLLAMA_NUM_CTX } }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      })
      if (!res.ok) {
        const errBody = typeof res.text === 'function' ? await res.text().catch(() => '(unreadable)') : '(unreadable)'
        console.warn(`[OllamaService] scoreTopCandidates: HTTP ${res.status} — ${errBody.slice(0, 200)}`)
        return null
      }
      const data = await res.json() as { response?: string }
      const rawResponse = data.response?.trim() ?? ''
      console.log(`[OllamaService] scoreTopCandidates raw response: ${rawResponse.slice(0, 300)}`)
      const raw = extractJson(rawResponse)
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) {
        console.warn(`[OllamaService] scoreTopCandidates: expected array, got ${typeof parsed} — raw: ${rawResponse.slice(0, 200)}`)
        return null
      }
      const results: SimilarArticleItem[] = []
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue
        const { index, similarityScore } = entry as { index?: unknown; similarityScore?: unknown }
        if (typeof index !== 'number' || typeof similarityScore !== 'number') continue
        if (index < 1 || index > candidates.length) continue
        const candidate = candidates[index - 1]
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
      console.warn(`[OllamaService] scoreTopCandidates failed: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  async findSimilarArticles(
    originalTitle: string,
    originalMeta: string,
    originalContent: string,
    candidates: RawFeedItem[],
  ): Promise<SimilarArticleItem[] | null> {
    if (candidates.length === 0) return []

    const maxCandidates = positiveIntEnv('OLLAMA_MAX_CANDIDATES', 200)
    const topK = positiveIntEnv('OLLAMA_PREFILTER_TOPK', 20)
    const capped = candidates.slice(0, maxCandidates)
    if (candidates.length > maxCandidates) {
      console.warn(`[OllamaService] findSimilarArticles: truncating ${candidates.length} candidates to ${maxCandidates}`)
    }

    const originalText = [originalTitle, originalMeta, originalContent.slice(0, 500)].filter(Boolean).join('. ')
    const candidateTexts = capped.map((c) => [c.title, c.description].filter(Boolean).join('. '))

    // Tier 3: embeddings unavailable → null → worker uses keyword heuristic
    const embeddings = await this.embed([originalText, ...candidateTexts])
    if (embeddings === null || embeddings.length !== candidateTexts.length + 1) {
      console.warn('[OllamaService] findSimilarArticles: embedding failed or count mismatch — returning null for heuristic fallback')
      return null
    }

    const originalVec = embeddings[0] ?? []
    const ranked = capped
      .map((candidate, i) => ({ candidate, cosine: cosineSimilarity(originalVec, embeddings[i + 1] ?? []) }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, topK)

    console.log(`[OllamaService] findSimilarArticles: embedded ${capped.length} candidates, scoring top ${ranked.length} with ${OLLAMA_MODEL}`)

    // Tier 1: gemma scores the top-K
    const generated = await this.scoreTopCandidates(originalTitle, originalMeta, originalContent, ranked.map((r) => r.candidate))
    if (generated !== null) return generated

    // Tier 2: generate failed — fall back to cosine scores on top-K
    console.warn('[OllamaService] findSimilarArticles: generate step failed — using cosine similarity scores')
    return ranked.map((r) => ({
      url: r.candidate.url,
      title: r.candidate.title || null,
      sourceDomain: r.candidate.sourceDomain,
      matchedKeywords: [],
      similarityScore: Math.min(1, Math.max(0, r.cosine)),
    }))
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

  async embed(inputs: string[]): Promise<number[][] | null> {
    if (inputs.length === 0) return []
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: inputs }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      })
      if (!res.ok) {
        console.warn(`[OllamaService] embed: HTTP ${res.status}`)
        return null
      }
      const data = await res.json() as { embeddings?: unknown }
      if (!Array.isArray(data.embeddings)) {
        console.warn('[OllamaService] embed: response missing embeddings array')
        return null
      }
      return data.embeddings as number[][]
    } catch (err) {
      console.warn(`[OllamaService] embed failed: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }
}
