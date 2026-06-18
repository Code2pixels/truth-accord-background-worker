const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://10.13.37.54:30068'
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'llama3.2'
const OLLAMA_TIMEOUT_MS = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? 15_000)

const CATEGORIES = [
  'politics', 'economics', 'science', 'health', 'technology',
  'education', 'law', 'environment', 'world', 'society',
] as const

const PROMPT_PREFIX = `You are a news article classifier. Given the title and summary of a news article, respond with exactly one word: the category that best fits from this list: ${CATEGORIES.join(', ')}, none. Do not explain. Do not add punctuation.

`

export class OllamaService {
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
