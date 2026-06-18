import type { OllamaContentScores, OllamaSimilarArticlesScore } from '../types.ts'

const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://10.13.37.54:30068'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'llama3.2'
const OLLAMA_TIMEOUT_MS = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 15_000)

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
      const raw = data.response?.trim() ?? ''
      const parsed = JSON.parse(raw) as { category?: unknown; biasScore?: unknown; languageScore?: unknown }
      const category = typeof parsed.category === 'string' && (CATEGORIES as readonly string[]).includes(parsed.category)
        ? parsed.category
        : null
      return { category, biasScore: clamp(parsed.biasScore), languageScore: clamp(parsed.languageScore) }
    } catch {
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
      const raw = data.response?.trim() ?? ''
      const parsed = JSON.parse(raw) as { similarArticlesScore?: unknown }
      return { similarArticlesScore: clamp(parsed.similarArticlesScore) }
    } catch {
      return { similarArticlesScore: null }
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
