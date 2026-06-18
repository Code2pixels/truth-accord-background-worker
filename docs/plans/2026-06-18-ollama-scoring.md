# Ollama LLM Scoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two LLM-powered scoring methods to `OllamaService` — one that classifies topic and scores bias + language in a single call, and one that scores similar-article corroboration — then wire them into `ScrapeWorker` with console.log output only.

**Architecture:** `scoreContentAndClassify()` replaces the existing standalone `classifyTopic()` Ollama fallback call in the scrape worker (keyword fast path is unchanged), returning category + biasScore + languageScore in one JSON response. `scoreSimilarArticles()` runs after step 6 (similar articles found) and returns a single corroboration score. Both fall back to null on any error. No DB writes.

**Tech Stack:** Node.js, TypeScript, native `node:test`, global `fetch` (mocked in tests via `mock.method`)

---

### Task 1: Add OllamaScores types to types.ts

**Files:**
- Modify: `src/types.ts`

**Step 1: Add the two new interfaces at the bottom of the file**

```typescript
export interface OllamaContentScores {
  category: string | null
  biasScore: number | null
  languageScore: number | null
}

export interface OllamaSimilarArticlesScore {
  similarArticlesScore: number | null
}
```

**Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add OllamaContentScores and OllamaSimilarArticlesScore types"
```

---

### Task 2: Add `scoreContentAndClassify` to OllamaService

**Files:**
- Modify: `src/services/ollama.service.ts`
- Create: `src/services/ollama.service.test.ts`

**Step 1: Write the failing test**

Create `src/services/ollama.service.test.ts`:

```typescript
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OllamaService } from './ollama.service.ts'

function makeFetchMock(responseText: string, ok = true) {
  return mock.fn(async () => ({
    ok,
    json: async () => ({ response: responseText }),
  }))
}

describe('OllamaService.scoreContentAndClassify', () => {
  let service: OllamaService

  beforeEach(() => {
    service = new OllamaService()
  })

  it('returns parsed scores and category on valid JSON response', async (t) => {
    const fetchMock = makeFetchMock('{"category":"politics","biasScore":70,"languageScore":80}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Senate passes bill', 'Congress acted', '')
    assert.equal(result.category, 'politics')
    assert.equal(result.biasScore, 70)
    assert.equal(result.languageScore, 80)
  })

  it('returns null category for unrecognized category value', async (t) => {
    const fetchMock = makeFetchMock('{"category":"sports","biasScore":30,"languageScore":20}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.equal(result.category, null)
    assert.equal(result.biasScore, 30)
  })

  it('clamps scores outside 0-100 range', async (t) => {
    const fetchMock = makeFetchMock('{"category":"science","biasScore":150,"languageScore":-10}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.equal(result.biasScore, 100)
    assert.equal(result.languageScore, 0)
  })

  it('returns all nulls on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.deepEqual(result, { category: null, biasScore: null, languageScore: null })
  })

  it('returns all nulls on non-ok response', async (t) => {
    const fetchMock = makeFetchMock('', false)
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.deepEqual(result, { category: null, biasScore: null, languageScore: null })
  })

  it('returns all nulls on malformed JSON', async (t) => {
    const fetchMock = makeFetchMock('not json at all')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.deepEqual(result, { category: null, biasScore: null, languageScore: null })
  })
})
```

**Step 2: Run test to confirm it fails**

```bash
npm test -- --test-name-pattern="scoreContentAndClassify"
```
Expected: FAIL — method does not exist yet

**Step 3: Add the `clamp` helper and `scoreContentAndClassify` method to ollama.service.ts**

Add this helper at the module level (before the class):

```typescript
function clamp(val: unknown): number | null {
  if (typeof val !== 'number' || isNaN(val)) return null
  return Math.round(Math.min(100, Math.max(0, val)))
}
```

Add to the `OllamaService` class:

```typescript
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
```

Also add the import at the top of the file:

```typescript
import type { OllamaContentScores, OllamaSimilarArticlesScore } from '../types.ts'
```

**Step 4: Run tests**

```bash
npm test -- --test-name-pattern="scoreContentAndClassify"
```
Expected: all 6 tests PASS

**Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

**Step 6: Commit**

```bash
git add src/services/ollama.service.ts src/services/ollama.service.test.ts
git commit -m "feat: add scoreContentAndClassify to OllamaService"
```

---

### Task 3: Add `scoreSimilarArticles` to OllamaService

**Files:**
- Modify: `src/services/ollama.service.ts`
- Modify: `src/services/ollama.service.test.ts`

**Step 1: Add failing tests to the test file**

Append to `src/services/ollama.service.test.ts`:

```typescript
describe('OllamaService.scoreSimilarArticles', () => {
  let service: OllamaService

  beforeEach(() => {
    service = new OllamaService()
  })

  it('returns parsed score on valid response', async (t) => {
    const fetchMock = makeFetchMock('{"similarArticlesScore":85}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreSimilarArticles('Senate bill passes', [
      { sourceDomain: 'bbc.com', similarityScore: 0.9, title: 'Senate votes on bill' },
      { sourceDomain: 'reuters.com', similarityScore: 0.75, title: null },
    ])
    assert.equal(result.similarArticlesScore, 85)
  })

  it('clamps score above 100', async (t) => {
    const fetchMock = makeFetchMock('{"similarArticlesScore":120}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreSimilarArticles('Title', [{ sourceDomain: 'ap.org', similarityScore: 0.8, title: null }])
    assert.equal(result.similarArticlesScore, 100)
  })

  it('returns null on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))

    const result = await service.scoreSimilarArticles('Title', [])
    assert.deepEqual(result, { similarArticlesScore: null })
  })

  it('returns null on malformed JSON', async (t) => {
    const fetchMock = makeFetchMock('garbage')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreSimilarArticles('Title', [])
    assert.deepEqual(result, { similarArticlesScore: null })
  })
})
```

**Step 2: Run tests to confirm they fail**

```bash
npm test -- --test-name-pattern="scoreSimilarArticles"
```
Expected: FAIL — method does not exist

**Step 3: Add `scoreSimilarArticles` method to the class**

```typescript
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
```

**Step 4: Run all ollama tests**

```bash
npm test -- --test-name-pattern="OllamaService"
```
Expected: all tests PASS

**Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

**Step 6: Commit**

```bash
git add src/services/ollama.service.ts src/services/ollama.service.test.ts
git commit -m "feat: add scoreSimilarArticles to OllamaService"
```

---

### Task 4: Wire scoring into ScrapeWorker

**Files:**
- Modify: `src/workers/scrape-worker.ts`

**Context:** In `processJob()`:
- **Step 4** (lines ~114–131): currently calls `this.ollama.classifyTopic()` as the Ollama fallback. Replace this call with `this.ollama.scoreContentAndClassify()` and log bias/language scores when they come back.
- **After step 6** (after `itemsToSave` is determined and non-empty): add a call to `this.ollama.scoreSimilarArticles()` and log the result.

**Step 1: Replace the `classifyTopic` Ollama call in Step 4**

Find this block in `processJob`:

```typescript
if (!articleCategory) {
  console.log(`[Job ${id}] [4/7] Keyword classifier returned null — asking Ollama...`)
  articleCategory = await this.ollama.classifyTopic(scraped.title ?? '', scraped.metaDescription ?? '')
  if (articleCategory) {
    console.log(`[Job ${id}] [4/7] Ollama classified as: ${articleCategory}`)
  }
}
```

Replace with:

```typescript
if (!articleCategory) {
  console.log(`[Job ${id}] [4/7] Keyword classifier returned null — asking Ollama...`)
  const ollamaContent = await this.ollama.scoreContentAndClassify(
    scraped.title ?? '',
    scraped.metaDescription ?? '',
    scraped.content ?? '',
  )
  articleCategory = ollamaContent.category
  if (articleCategory) {
    console.log(`[Job ${id}] [4/7] Ollama classified as: ${articleCategory}`)
  }
  console.log(`[Job ${id}]       [Ollama] biasScore: ${ollamaContent.biasScore ?? 'null'} | languageScore: ${ollamaContent.languageScore ?? 'null'}`)
}
```

**Step 2: Add similar articles scoring after step 6**

Find the block right after `itemsToSave` logging and before the "If no similar articles found" check:

```typescript
console.log(`[Job ${id}]       matches found: ${matchResult.count}, above threshold: ${itemsToSave.length}`)
if (itemsToSave.length > 0) {
  for (const it of itemsToSave) {
    console.log(`[Job ${id}]         • [${(it.similarityScore * 100).toFixed(1)}%] ${it.sourceDomain} — ${it.title ?? it.url}`)
  }
}
```

Add after that `if` block (before the "If no similar articles found" comment):

```typescript
// Ollama: score similar articles corroboration
if (itemsToSave.length > 0) {
  const ollamaSimilar = await this.ollama.scoreSimilarArticles(scraped.title ?? '', itemsToSave)
  console.log(`[Job ${id}]       [Ollama] similarArticlesScore: ${ollamaSimilar.similarArticlesScore ?? 'null'}`)
}
```

**Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors

**Step 4: Run all tests**

```bash
npm test
```
Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/workers/scrape-worker.ts
git commit -m "feat: wire OllamaService scoring into ScrapeWorker"
```
