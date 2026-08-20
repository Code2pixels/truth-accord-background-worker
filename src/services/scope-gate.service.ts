/**
 * Decides whether a feed item is worth scraping at all.
 *
 * Two thirds of everything this worker scraped was rejected downstream for being
 * outside politics, world and law — 910 of 1350 researched articles. Each one
 * cost a fetch, an article row, a queue row and a research job before anything
 * noticed. This asks the same question the research service asks, using the same
 * embedding model, but early enough to skip the work entirely.
 *
 * Mirrors truth-accord-research/src/research/analysis/scope.py: same anchors,
 * same margin, same fail-open rule. Keep the two in step.
 */

const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://10.13.37.54:30068'
const OLLAMA_EMBED_MODEL = process.env['OLLAMA_EMBED_MODEL'] ?? 'nomic-embed-text'
const EMBED_TIMEOUT_MS = Number(process.env['SCOPE_GATE_TIMEOUT_MS'] ?? 60_000)

/**
 * Texts per embedding request. A whole feed in one call takes ~40s for 200 real
 * headlines-with-summaries, which blew a single timeout and silently failed the
 * gate open. Chunking keeps each call a few seconds and bounds the blast radius
 * of one slow request.
 */
const EMBED_CHUNK_SIZE = Number(process.env['SCOPE_GATE_CHUNK_SIZE'] ?? 32)

/** How far "other" must beat every in-scope anchor before an item is dropped. */
const MARGIN = Number(process.env['SCOPE_GATE_MARGIN'] ?? 0.02)

export const SCOPE_ANCHORS: Record<string, string> = {
  politics:
    'government policy, elections, legislation, parliament, congress, ministers, ' +
    'political parties, public administration, immigration policy, federal agencies',
  world:
    'international affairs, foreign policy, diplomacy, war, treaties, sanctions, ' +
    'other countries, global conflict, the United Nations, cross-border relations',
  law:
    'courts, lawsuits, judges, prosecutions, legal rulings, indictments, ' +
    'legislation, regulation, crime and justice, constitutional rights',
  other:
    'technology and gadgets, business and markets, sport, health and medicine, ' +
    'science research, entertainment and celebrities, lifestyle, consumer products',
}

const OUT_OF_SCOPE = 'other'

export type EmbedFn = (inputs: string[]) => Promise<number[][] | null>

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
  const result = dot / (Math.sqrt(magA) * Math.sqrt(magB))
  return Number.isFinite(result) ? result : 0
}

async function embedViaOllama(inputs: string[]): Promise<number[][] | null> {
  if (inputs.length === 0) return []
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: inputs }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { embeddings?: unknown }
    return Array.isArray(data.embeddings) ? (data.embeddings as number[][]) : null
  } catch {
    return null
  }
}

export class ScopeGateService {
  private anchors: Array<[string, number[]]> | null = null

  constructor(
    private readonly embed: EmbedFn = embedViaOllama,
    private readonly margin: number = MARGIN,
  ) {}

  get enabled(): boolean {
    return process.env['SCOPE_GATE_ENABLED'] !== 'false'
  }

  /**
   * Keep-or-drop for a batch of items, in the order given.
   *
   * Fails open: if the model is unreachable or returns the wrong shape, every
   * item is kept. An outage must not silently stop ingestion.
   */
  async keep(texts: string[]): Promise<boolean[]> {
    if (!this.enabled || texts.length === 0) return texts.map(() => true)

    const anchors = await this.getAnchors()
    if (!anchors) return texts.map(() => true)

    const vectors = await this.embedInChunks(texts)
    if (!vectors || vectors.length !== texts.length) return texts.map(() => true)

    return vectors.map((vector, i) => {
      if (!texts[i]?.trim()) return true
      const scores = anchors.map(([name, anchor]): [string, number] => [
        name,
        cosineSimilarity(vector, anchor),
      ])
      const other = scores.find(([name]) => name === OUT_OF_SCOPE)?.[1] ?? 0
      const bestInScope = Math.max(
        ...scores.filter(([name]) => name !== OUT_OF_SCOPE).map(([, score]) => score),
      )
      if (bestInScope >= other) return true
      // A near-tie is exactly what a cheap gate gets wrong — let it through and
      // let the research service's chat model decide.
      return other - bestInScope <= this.margin
    })
  }

  /** Embed a batch of any size, a chunk at a time. Any failed chunk aborts. */
  private async embedInChunks(texts: string[]): Promise<number[][] | null> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_CHUNK_SIZE) {
      const chunk = texts.slice(i, i + EMBED_CHUNK_SIZE)
      const vectors = await this.embed(chunk)
      if (!vectors || vectors.length !== chunk.length) return null
      out.push(...vectors)
    }
    return out
  }

  private async getAnchors(): Promise<Array<[string, number[]]> | null> {
    if (this.anchors) return this.anchors
    const names = Object.keys(SCOPE_ANCHORS)
    const vectors = await this.embed(names.map((n) => SCOPE_ANCHORS[n] ?? ''))
    if (!vectors || vectors.length !== names.length) return null
    this.anchors = names.map((name, i): [string, number[]] => [name, vectors[i] ?? []])
    return this.anchors
  }
}
