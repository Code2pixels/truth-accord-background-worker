# Embedding Pre-Filter (C-hybrid) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the "send all candidates to gemma" approach with an embedding pre-filter: embed all candidates, cosine-rank them, send only the top-K to gemma for final scoring. Keyword heuristic remains the last-resort fallback.

**Architecture:** Three-tier fallback inside `OllamaService.findSimilarArticles()`: (1) embeddings rank → gemma scores top-K; (2) gemma fails → cosine scores on top-K; (3) embed endpoint down → return `null` so the worker uses the keyword heuristic. The scrape worker's Step 6 is unchanged.

**Tech Stack:** Node.js, TypeScript, `node:test` + `tsx`. Ollama `/api/embed` (batched embeddings) and `/api/generate`.

**Test command:** `npm test`  ·  **Typecheck:** `npm run typecheck`

**Note on working tree:** `ollama.service.ts` and `ollama.service.test.ts` already have uncommitted changes from a prior fix (JSON mode `format:'json'`, `num_ctx`, diagnostic logging, and a "requests JSON mode" test). This plan builds on top of those — keep them. Everything is committed together at the end (do NOT commit per-task).

---

### Task 1: `cosineSimilarity` pure function — TDD

**Files:**
- Modify: `src/services/ollama.service.ts`
- Modify: `src/services/ollama.service.test.ts`

**Step 1: Write failing tests.** Append to the test file:

```ts
import { cosineSimilarity } from './ollama.service.ts'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
  })
  it('returns 0 for orthogonal vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9)
  })
  it('returns 0 when either vector is all zeros (no divide-by-zero)', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0)
  })
  it('handles differing lengths by using the shorter length', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 5], [1, 0]) - 1) < 1e-9)
  })
})
```

Note: `cosineSimilarity` must be `export`ed for the import. Add `cosineSimilarity` to the existing import line from `./ollama.service.ts` if there is one, otherwise add a new import.

**Step 2: Run tests, confirm failure** (`cosineSimilarity is not exported / not a function`):
```bash
npm test 2>&1 | grep -iE 'cosineSimilarity|fail' | head
```

**Step 3: Implement.** Add this module-level exported function near `clamp`/`extractJson` in `ollama.service.ts`:

```ts
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
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}
```

**Step 4: Run tests, confirm pass.** **Step 5: Typecheck.**

---

### Task 2: `embed()` method — TDD

**Files:**
- Modify: `src/services/ollama.service.ts`
- Modify: `src/services/ollama.service.test.ts`

**Step 1: Add the embed-model constant** near the other constants at the top of `ollama.service.ts`:

```ts
const OLLAMA_EMBED_MODEL = process.env['OLLAMA_EMBED_MODEL'] ?? 'nomic-embed-text'
```

**Step 2: Write failing tests.** Append to the test file. (`makeFetchMock` only models `{ response }`; for embed we need an embeddings body, so use a small inline mock.)

```ts
function makeEmbedMock(body: unknown, ok = true) {
  return mock.fn(async () => ({ ok, json: async () => body }))
}

describe('OllamaService.embed', () => {
  let service: OllamaService
  beforeEach(() => { service = new OllamaService() })

  it('returns the embeddings array on success', async (t) => {
    t.mock.method(globalThis, 'fetch', makeEmbedMock({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }))
    const result = await service.embed(['a', 'b'])
    assert.deepEqual(result, [[0.1, 0.2], [0.3, 0.4]])
  })
  it('returns empty array without calling fetch for empty input', async (t) => {
    const m = makeEmbedMock({ embeddings: [] })
    t.mock.method(globalThis, 'fetch', m)
    const result = await service.embed([])
    assert.deepEqual(result, [])
    assert.equal(m.mock.calls.length, 0)
  })
  it('returns null on non-ok response', async (t) => {
    t.mock.method(globalThis, 'fetch', makeEmbedMock({}, false))
    assert.equal(await service.embed(['a']), null)
  })
  it('returns null on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))
    assert.equal(await service.embed(['a']), null)
  })
  it('returns null when embeddings field is missing', async (t) => {
    t.mock.method(globalThis, 'fetch', makeEmbedMock({ notEmbeddings: true }))
    assert.equal(await service.embed(['a']), null)
  })
})
```

**Step 3: Run tests, confirm failure. Step 4: Implement** the method in `OllamaService`:

```ts
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
```

**Step 5: Run tests + typecheck, confirm pass.**

---

### Task 3: Rework `findSimilarArticles()` with embedding pre-filter — TDD

**Files:**
- Modify: `src/services/ollama.service.ts`
- Modify: `src/services/ollama.service.test.ts`

**Step 1: Extract the existing generate logic into a private `scoreTopCandidates()`.** Take the current body of `findSimilarArticles` (the part that builds the candidate-list prompt, calls `/api/generate` with `format:'json'` and `num_ctx`, parses the JSON array, and maps indices to `SimilarArticleItem[]`) and move it verbatim into a new private method that operates on a (small, top-K) candidate list:

```ts
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
```

**Step 2: Rewrite `findSimilarArticles()`** to orchestrate embed → rank → top-K → `scoreTopCandidates`, with Tier 2/3 fallbacks:

```ts
async findSimilarArticles(
  originalTitle: string,
  originalMeta: string,
  originalContent: string,
  candidates: RawFeedItem[],
): Promise<SimilarArticleItem[] | null> {
  if (candidates.length === 0) return []

  const maxCandidates = Number(process.env['OLLAMA_MAX_CANDIDATES'] ?? 200)
  const topK = Number(process.env['OLLAMA_PREFILTER_TOPK'] ?? 20)
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
```

**Step 3: Update the existing `findSimilarArticles` tests** to the two-endpoint world. The old tests mocked only `/api/generate`; now `findSimilarArticles` calls `/api/embed` first. Add a URL-routing mock helper to the test file:

```ts
function makeRoutedMock(routes: { embed?: unknown; embedOk?: boolean; generate?: string; generateOk?: boolean }) {
  return mock.fn(async (url: string) => {
    if (url.includes('/api/embed')) {
      return { ok: routes.embedOk ?? true, json: async () => routes.embed ?? { embeddings: [] } }
    }
    return { ok: routes.generateOk ?? true, json: async () => ({ response: routes.generate ?? '[]' }) }
  })
}
```

Then update/replace the `findSimilarArticles` describe block tests so each provides an embed response with the right number of vectors. Required test cases:

1. **Tier 1 happy path:** embed returns `[originalVec, ...candidateVecs]`; generate returns a JSON array; assert returned items map to the correct candidate URLs and normalized scores. Provide vectors that produce a predictable ranking (e.g. make candidate 1 and 3 most similar to original).
2. **Respects top-K:** set `process.env.OLLAMA_PREFILTER_TOPK = '1'` (restore after), provide 3 candidates; assert `scoreTopCandidates` receives only 1 (verify the generate prompt only lists 1 candidate, or that at most 1 item returns). Reset env in a `finally`.
3. **Tier 2 (generate fails → cosine):** embed succeeds, generate mock returns `generateOk: false`; assert result is non-null and scores equal the clamped cosine values of the top-K (not null).
4. **Tier 3 (embed fails → null):** embed mock returns `embedOk: false`; assert result is `null`.
5. **Embed count mismatch → null:** embed returns fewer vectors than inputs; assert `null`.
6. **Empty candidates → `[]`** without any fetch call (keep existing test; ensure it still passes — `embed` is not called because of the early return).
7. Keep the existing **"requests JSON mode and an expanded context window"** test but point it at the routed mock and assert against the `/api/generate` call specifically (filter `fetchMock.mock.calls` for the one whose first arg includes `/api/generate`).

Delete or rewrite the old single-endpoint `findSimilarArticles` tests that assumed only `/api/generate` was called (the malformed-JSON, non-array, out-of-range-index, clamping cases). Those behaviors now live in `scoreTopCandidates`; re-point them through the routed mock with a valid embed response so they still exercise the same parsing logic end-to-end.

**Step 4: Run tests, confirm all pass. Step 5: Typecheck.**

---

### Task 4: Update `.env.example`

**Files:**
- Modify: `.env.example`

Under the Ollama section, add:
```
OLLAMA_EMBED_MODEL=nomic-embed-text      # embedding model for semantic candidate pre-filter (pull on the Ollama instance)
OLLAMA_PREFILTER_TOPK=20                 # how many top-ranked candidates gemma scores after embedding pre-filter
```

Run `npm run typecheck` and `npm test` once more — all green.

---

## Done

`findSimilarArticles` now embeds all candidates, cosine-ranks them, and sends only the top-K to gemma — fixing context overflow and improving match quality, with cosine scores (Tier 2) and the keyword heuristic (Tier 3) as graceful fallbacks.
