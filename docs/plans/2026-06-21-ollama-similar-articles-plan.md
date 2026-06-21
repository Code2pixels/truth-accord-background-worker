# Ollama-Primary Similar Article Matching — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Ollama the primary engine for finding and scoring similar articles from RSS feeds, falling back to the existing keyword/bigram/entity heuristic when Ollama is unavailable or fails.

**Architecture:** Add `getAllFeedItems()` to `ReferenceSitesCrawlService` to expose raw RSS items without filtering. Add `findSimilarArticles()` to `OllamaService` that sends all raw candidates to Ollama and returns scored results (or `null` on failure). Update the scrape worker to try Ollama first and fall back to the existing `getMatchingArticles()` path. Move the hardcoded similarity threshold to an env variable.

**Tech Stack:** Node.js, TypeScript, `node:test` (built-in test runner), `tsx` for TypeScript execution.

**Test command:** `npm test`
**Typecheck command:** `npm run typecheck`

---

### Task 1: Expose raw feed items from `ReferenceSitesCrawlService`

**Files:**
- Modify: `src/services/truthfulness/reference-sites-crawl.service.ts`

The existing `getMatchesInFeed()` private method already fetches and parses feed items. We need a public `getAllFeedItems()` that reuses the private `getFeedItems()` parser but skips scoring.

**Step 1: Add the `RawFeedItem` interface and `getAllFeedItems()` method**

In `reference-sites-crawl.service.ts`, add the exported interface near the top (after the existing `SimilarArticleItem` interface) and add the method to the class:

```ts
export interface RawFeedItem {
  url: string
  title: string
  description: string
  sourceDomain: string
}
```

Add this method to `ReferenceSitesCrawlService`:

```ts
async getAllFeedItems(): Promise<RawFeedItem[]> {
  const sites = await this.getSites()
  const all: RawFeedItem[] = []

  await Promise.all(
    sites.map(async (site) => {
      try {
        const res = await globalThis.fetch(site.feedUrl, {
          signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthAccordBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
        })
        const xml = await res.text()
        const items = this.getFeedItems(xml)
        for (const it of items) {
          if (!it.url?.startsWith('http')) continue
          all.push({ url: it.url, title: it.title ?? '', description: it.description ?? '', sourceDomain: site.domain })
        }
      } catch (err) {
        console.warn(`[ReferenceCrawl] getAllFeedItems fetch failed: ${site.feedUrl}`, err instanceof Error ? err.message : err)
      }
    }),
  )

  return all
}
```

**Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/services/truthfulness/reference-sites-crawl.service.ts
git commit -m "feat: expose getAllFeedItems() on ReferenceSitesCrawlService"
```

---

### Task 2: Add `findSimilarArticles()` to `OllamaService` — tests first

**Files:**
- Modify: `src/services/ollama.service.test.ts`
- Modify: `src/services/ollama.service.ts`

**Step 1: Write the failing tests**

Append this `describe` block to `src/services/ollama.service.test.ts`:

```ts
describe('OllamaService.findSimilarArticles', () => {
  let service: OllamaService

  const candidates = [
    { url: 'https://bbc.com/1', title: 'Senate passes bill', description: 'Congress acts on bill', sourceDomain: 'bbc.com' },
    { url: 'https://fox.com/2', title: 'Sports results', description: 'Team wins game', sourceDomain: 'fox.com' },
    { url: 'https://reuters.com/3', title: 'Senate vote on legislation', description: 'Bill passes Senate vote', sourceDomain: 'reuters.com' },
  ]

  beforeEach(() => {
    service = new OllamaService()
  })

  it('returns matched candidates with normalised similarity scores', async (t) => {
    // Ollama says candidates 1 and 3 are similar (1-based index)
    const fetchMock = makeFetchMock('[{"index":1,"similarityScore":90},{"index":3,"similarityScore":60}]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Senate bill passes', 'Congress acts', '', candidates)
    assert.ok(result !== null)
    assert.equal(result!.length, 2)
    assert.equal(result![0]!.url, 'https://bbc.com/1')
    assert.ok(Math.abs(result![0]!.similarityScore - 0.9) < 0.001)
    assert.equal(result![1]!.url, 'https://reuters.com/3')
    assert.ok(Math.abs(result![1]!.similarityScore - 0.6) < 0.001)
  })

  it('returns empty array when Ollama returns empty array', async (t) => {
    const fetchMock = makeFetchMock('[]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result!.length, 0)
  })

  it('clamps similarity scores to 0-1 range', async (t) => {
    const fetchMock = makeFetchMock('[{"index":1,"similarityScore":150}]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result![0]!.similarityScore, 1)
  })

  it('ignores out-of-range indices from Ollama', async (t) => {
    const fetchMock = makeFetchMock('[{"index":0,"similarityScore":80},{"index":99,"similarityScore":70}]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result!.length, 0)
  })

  it('returns null on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns null on non-ok response', async (t) => {
    const fetchMock = makeFetchMock('', false)
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns null on malformed JSON', async (t) => {
    const fetchMock = makeFetchMock('not json')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns null on JSON that is not an array', async (t) => {
    const fetchMock = makeFetchMock('{"index":1,"similarityScore":80}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns empty array when candidates list is empty', async (t) => {
    // Should not call fetch at all — nothing to score
    const fetchMock = makeFetchMock('[]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', [])
    assert.ok(result !== null)
    assert.equal(result!.length, 0)
    assert.equal(fetchMock.mock.calls.length, 0)
  })
})
```

**Step 2: Run tests to confirm they fail**

```bash
npm test 2>&1 | grep -E 'findSimilarArticles|FAIL|not a function'
```

Expected: failures like `service.findSimilarArticles is not a function`.

**Step 3: Implement `findSimilarArticles()` in `OllamaService`**

Also import `RawFeedItem` and `SimilarArticleItem` types at the top. Add this method to the class in `src/services/ollama.service.ts`:

First, add the import at the top of the file:
```ts
import type { RawFeedItem } from './truthfulness/reference-sites-crawl.service.ts'
import type { SimilarArticleItem } from './truthfulness/reference-sites-crawl.service.ts'
```

Then add the method:

```ts
async findSimilarArticles(
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
      const candidate = candidates[index - 1]
      if (!candidate) continue
      const score = Math.min(1, Math.max(0, Math.round(similarityScore) / 100))
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
```

**Step 4: Run tests to confirm they pass**

```bash
npm test 2>&1 | grep -E 'findSimilarArticles|pass|fail' -i
```

Expected: all `findSimilarArticles` tests pass.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/services/ollama.service.ts src/services/ollama.service.test.ts
git commit -m "feat: add findSimilarArticles() to OllamaService with Ollama-primary scoring"
```

---

### Task 3: Update scrape worker — Ollama primary, heuristic fallback, env threshold

**Files:**
- Modify: `src/workers/scrape-worker.ts`
- Modify: `.env.example`

**Step 1: Replace `MIN_SIMILARITY_TO_SAVE` constant with env var and update Step 6**

In `src/workers/scrape-worker.ts`:

- Remove line 14: `const MIN_SIMILARITY_TO_SAVE = 0.25`
- Add at the top of `processJob` (or alongside other env reads in the constructor):

```ts
private readonly minSimilarityScore: number

// In constructor, add:
this.minSimilarityScore = Number(process.env['SIMILAR_ARTICLE_MIN_SCORE'] ?? 0.25)
```

Replace Step 6 (lines 157–192 roughly) with:

```ts
// Step 6: Similar articles — Ollama primary, heuristic fallback
const title = scraped.title?.trim() ?? ''
const meta = scraped.metaDescription?.trim() ?? ''
console.log(`[Job ${id}] [6/7] Finding similar articles via Ollama...`)

const rawCandidates = await this.referenceSitesCrawl.getAllFeedItems()
console.log(`[Job ${id}]       raw candidates from feeds: ${rawCandidates.length}`)

let similarItems = await this.ollama.findSimilarArticles(title, meta, scraped.content ?? '', rawCandidates)

if (similarItems === null) {
  console.warn(`[Job ${id}]       Ollama unavailable — falling back to heuristic matching`)
  const matchResult = await this.referenceSitesCrawl.getMatchingArticles(title, meta, scraped.content ?? '')
  similarItems = matchResult.items
}

const normalizedSourceDomain = sourceDomain.replace(/^www\./, '')
const itemsToSave = similarItems.filter((it) =>
  (it.similarityScore ?? 0) >= this.minSimilarityScore && it.sourceDomain !== normalizedSourceDomain,
)
console.log(`[Job ${id}]       matches found: ${similarItems.length}, above threshold (${this.minSimilarityScore}): ${itemsToSave.length}`)
if (itemsToSave.length > 0) {
  for (const it of itemsToSave) {
    console.log(`[Job ${id}]         • [${(it.similarityScore * 100).toFixed(1)}%] ${it.sourceDomain} — ${it.title ?? it.url}`)
  }
}
```

Note: the existing `referenceSitesCrawl` variable in Step 6 logs `keywords extracted from:` — remove that line since Ollama doesn't use keywords.

**Step 2: Update `.env.example`**

In `.env.example`, update the "Reference sites crawl" section and the Ollama comment:

```
# Reference sites crawl
SEARCH_FEED_TIMEOUT_MS=8000           # timeout per reference feed fetch (ms)
REFERENCE_MIN_WORD_LENGTH=4           # minimum word length when extracting keywords (heuristic fallback only)
REFERENCE_MIN_KEYWORD_MATCH=2         # minimum keyword matches to count an article as similar (heuristic fallback only)
SIMILAR_ARTICLE_MIN_SCORE=0.25        # minimum similarity score (0–1) to save a similar article match

# Ollama (topic classification + similar article matching; falls back to heuristics if unavailable)
OLLAMA_BASE_URL=http://10.13.37.54:30068  # Ollama instance URL
OLLAMA_MODEL=llama3.2                     # model name to use
OLLAMA_TIMEOUT_MS=15000                   # request timeout (ms)
```

**Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Run all tests**

```bash
npm test
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/workers/scrape-worker.ts .env.example
git commit -m "feat: use Ollama as primary similar-article finder with heuristic fallback; move threshold to SIMILAR_ARTICLE_MIN_SCORE env var"
```

---

## Done

All three tasks complete. The pipeline now:
1. Fetches all raw RSS feed items
2. Sends them to Ollama for similarity scoring (with match %)
3. Falls back to keyword/bigram/entity heuristic if Ollama returns `null`
4. Filters by `SIMILAR_ARTICLE_MIN_SCORE` (env-configurable, default 0.25)
