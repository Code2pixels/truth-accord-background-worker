# Similar Articles Matching Improvement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace weak unigram keyword overlap with named entity + bigram matching so similar articles reflect the same specific story, not just the same broad topic.

**Architecture:** Extract bigrams from the article title and named entities from the full content body, require both to appear in a candidate before accepting it, and replace the flat similarity score with a weighted formula across all three signal types. Raise `MIN_SIMILARITY_TO_SAVE` from 0.2 → 0.4.

**Tech Stack:** TypeScript, Node built-in test runner (`node:test`), no new dependencies.

**Design doc:** `docs/plans/2026-06-16-similar-articles-matching-design.md`

---

### Task 1: Add tests for `extractBigrams`

**Files:**
- Create: `src/services/truthfulness/reference-sites-crawl.test.ts`

**Step 1: Create the test file**

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReferenceSitesCrawlService } from './reference-sites-crawl.service.ts'

// We test private methods via casting
const svc = new ReferenceSitesCrawlService(null as never)
const extractBigrams = (svc as unknown as Record<string, (s: string) => Set<string>>)['extractBigrams'].bind(svc)

describe('extractBigrams', () => {
  it('returns bigrams from a normal title', () => {
    const result = extractBigrams('Election fraud claims rejected by court')
    assert.ok(result.has('election fraud'), 'expected "election fraud"')
    assert.ok(result.has('fraud claims'), 'expected "fraud claims"')
    assert.ok(result.has('claims rejected'), 'expected "claims rejected"')
  })

  it('filters out bigrams containing stop words', () => {
    const result = extractBigrams('Trump signs the new bill')
    assert.ok(!result.has('signs the'), 'should not include "signs the"')
    assert.ok(!result.has('the new'), 'should not include "the new"')
  })

  it('returns empty set for short title', () => {
    assert.equal(extractBigrams('Trade').size, 0)
  })

  it('is case-insensitive', () => {
    const result = extractBigrams('NATO Summit begins')
    assert.ok(result.has('nato summit'))
  })
})
```

**Step 2: Run to confirm it fails**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm test 2>&1 | tail -30
```

Expected: error — `extractBigrams is not a function`

---

### Task 2: Implement `extractBigrams`

**Files:**
- Modify: `src/services/truthfulness/reference-sites-crawl.service.ts`

**Step 1: Add the method to `ReferenceSitesCrawlService` (after `extractKeywords`)**

```ts
private extractBigrams(title: string): Set<string> {
  const words = title.toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean)
  const set = new Set<string>()
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].replace(/^['-]+|['-]+$/g, '')
    const b = words[i + 1].replace(/^['-]+|['-]+$/g, '')
    if (a.length >= MIN_WORD_LENGTH && b.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(a) && !STOP_WORDS.has(b)) {
      set.add(`${a} ${b}`)
    }
  }
  return set
}
```

**Step 2: Run tests**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm test 2>&1 | tail -30
```

Expected: `extractBigrams` describe block passes, all 4 tests green.

**Step 3: Commit**

```bash
cd /home/brandee/repos/truth-accord-background-worker && git add src/services/truthfulness/reference-sites-crawl.service.ts src/services/truthfulness/reference-sites-crawl.test.ts && git commit -m "feat: add extractBigrams to reference crawl service"
```

---

### Task 3: Add tests for `extractNamedEntities`

**Files:**
- Modify: `src/services/truthfulness/reference-sites-crawl.test.ts`

**Step 1: Add describe block to the test file**

```ts
const extractNamedEntities = (svc as unknown as Record<string, (s: string) => Set<string>>)['extractNamedEntities'].bind(svc)

describe('extractNamedEntities', () => {
  it('extracts a single proper noun', () => {
    const result = extractNamedEntities('The president signed the bill. Donald Trump spoke today.')
    assert.ok(result.has('Donald Trump'), 'expected "Donald Trump"')
  })

  it('extracts multi-word entity', () => {
    const result = extractNamedEntities('Some text. Supreme Court ruled against the law.')
    assert.ok(result.has('Supreme Court'), 'expected "Supreme Court"')
  })

  it('does not extract first word of sentence (sentence-start false positive)', () => {
    const result = extractNamedEntities('Policy makers met today. Trade talks resumed.')
    assert.ok(!result.has('Policy'), 'sentence-start word should be excluded')
    assert.ok(!result.has('Trade'), 'sentence-start word should be excluded')
  })

  it('returns empty set for lowercase content', () => {
    const result = extractNamedEntities('the quick brown fox jumps over the lazy dog')
    assert.equal(result.size, 0)
  })

  it('handles empty string', () => {
    assert.equal(extractNamedEntities('').size, 0)
  })
})
```

**Step 2: Run to confirm it fails**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm test 2>&1 | tail -40
```

Expected: `extractNamedEntities is not a function`

---

### Task 4: Implement `extractNamedEntities`

**Files:**
- Modify: `src/services/truthfulness/reference-sites-crawl.service.ts`

**Step 1: Add the method (after `extractBigrams`)**

```ts
private extractNamedEntities(content: string): Set<string> {
  const set = new Set<string>()
  if (!content.trim()) return set

  // Split into sentences, skip the first token of each (capitalised as sentence-start, not as entity)
  const sentences = content.split(/(?<=[.!?])\s+/)
  for (const sentence of sentences) {
    const tokens = sentence.trim().split(/\s+/)
    // Walk from index 1 to skip sentence-opener
    let i = 1
    while (i < tokens.length) {
      const token = tokens[i].replace(/[^A-Za-z'-]/g, '')
      if (token.length >= 3 && /^[A-Z]/.test(token) && !STOP_WORDS.has(token.toLowerCase())) {
        // Collect run of capitalized tokens (up to 3)
        const run: string[] = [token]
        let j = i + 1
        while (j < tokens.length && run.length < 3) {
          const next = tokens[j].replace(/[^A-Za-z'-]/g, '')
          if (next.length >= 2 && /^[A-Z]/.test(next)) {
            run.push(next)
            j++
          } else break
        }
        set.add(run.join(' '))
        i = j
      } else {
        i++
      }
    }
  }
  return set
}
```

**Step 2: Run tests**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm test 2>&1 | tail -40
```

Expected: all `extractNamedEntities` tests pass.

**Step 3: Commit**

```bash
cd /home/brandee/repos/truth-accord-background-worker && git add src/services/truthfulness/reference-sites-crawl.service.ts src/services/truthfulness/reference-sites-crawl.test.ts && git commit -m "feat: add extractNamedEntities to reference crawl service"
```

---

### Task 5: Update `getMatchingArticles` signature and matching logic

**Files:**
- Modify: `src/services/truthfulness/reference-sites-crawl.service.ts`

**Step 1: Change `getMatchingArticles` and `getMatchingArticleCount` signatures to accept `content`**

Find:
```ts
async getMatchingArticles(originalTitle: string, originalMeta: string): Promise<{ count: number; items: SimilarArticleItem[] }> {
  const keywords = this.extractKeywords(originalTitle, originalMeta)
  if (keywords.size < MIN_KEYWORD_MATCH) return { count: 0, items: [] }

  const sites = await this.getSites()
  const allItems: SimilarArticleItem[] = []
  const totalKeywords = keywords.size

  await Promise.all(
    sites.map(async (site) => {
      const items = await this.getMatchesInFeed(site.feedUrl, site.domain, keywords, totalKeywords)
      allItems.push(...items)
    }),
  )

  return { count: allItems.length, items: allItems }
}

async getMatchingArticleCount(originalTitle: string, originalMeta: string): Promise<number> {
  const { count } = await this.getMatchingArticles(originalTitle, originalMeta)
  return count
}
```

Replace with:
```ts
async getMatchingArticles(originalTitle: string, originalMeta: string, content = ''): Promise<{ count: number; items: SimilarArticleItem[] }> {
  const keywords = this.extractKeywords(originalTitle, originalMeta)
  if (keywords.size < MIN_KEYWORD_MATCH) return { count: 0, items: [] }

  const titleBigrams = this.extractBigrams(originalTitle)
  const namedEntities = this.extractNamedEntities(content)

  const sites = await this.getSites()
  const allItems: SimilarArticleItem[] = []

  await Promise.all(
    sites.map(async (site) => {
      const items = await this.getMatchesInFeed(site.feedUrl, site.domain, keywords, titleBigrams, namedEntities)
      allItems.push(...items)
    }),
  )

  return { count: allItems.length, items: allItems }
}

async getMatchingArticleCount(originalTitle: string, originalMeta: string, content = ''): Promise<number> {
  const { count } = await this.getMatchingArticles(originalTitle, originalMeta, content)
  return count
}
```

**Step 2: Run typecheck**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm run typecheck 2>&1
```

Expected: errors on `getMatchesInFeed` call because signature hasn't changed yet — that's fine, continue.

---

### Task 6: Update `getMatchesInFeed` with new filters and weighted scoring

**Files:**
- Modify: `src/services/truthfulness/reference-sites-crawl.service.ts`

**Step 1: Update the constant at the top of the file**

Find:
```ts
const MIN_SIMILARITY_TO_SAVE = 0.2
```

Wait — that constant lives in `scrape-worker.ts`, not this file. Skip — it will be updated in Task 7.

**Step 1: Replace `getMatchesInFeed` signature and body**

Find:
```ts
private async getMatchesInFeed(feedUrl: string, sourceDomain: string, keywords: Set<string>, totalKeywords: number): Promise<SimilarArticleItem[]> {
  try {
    const res = await globalThis.fetch(feedUrl, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthAccordBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
    })
    const xml = await res.text()
    const items = this.getFeedItems(xml)
    const out: SimilarArticleItem[] = []
    for (const it of items) {
      const matchedKeywords = this.getMatchedKeywords(it.title, it.description, keywords)
      if (matchedKeywords.length < MIN_KEYWORD_MATCH) continue
      if (!isAllowedTopic(`${it.title} ${it.description}`)) continue
      const similarityScore = totalKeywords > 0 ? Math.min(1, Math.round((matchedKeywords.length / totalKeywords) * 10000) / 10000) : 0
      out.push({ url: it.url, title: it.title || null, sourceDomain, matchedKeywords, similarityScore })
    }
    return out
  } catch (err) {
    console.warn(`[ReferenceCrawl] Feed fetch failed: ${feedUrl}`, err instanceof Error ? err.message : err)
    return []
  }
}
```

Replace with:
```ts
private async getMatchesInFeed(
  feedUrl: string,
  sourceDomain: string,
  keywords: Set<string>,
  titleBigrams: Set<string>,
  namedEntities: Set<string>,
): Promise<SimilarArticleItem[]> {
  try {
    const res = await globalThis.fetch(feedUrl, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthAccordBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
    })
    const xml = await res.text()
    const items = this.getFeedItems(xml)
    const out: SimilarArticleItem[] = []

    for (const it of items) {
      const candidateText = `${it.title} ${it.description}`.toLowerCase()

      // Hard filter 1: unigram minimum
      const matchedKeywords = this.getMatchedKeywords(it.title, it.description, keywords)
      if (matchedKeywords.length < MIN_KEYWORD_MATCH) continue

      // Hard filter 2: at least one title bigram must match
      if (titleBigrams.size > 0) {
        const hasBigram = [...titleBigrams].some((bg) => candidateText.includes(bg))
        if (!hasBigram) continue
      }

      // Hard filter 3: at least one named entity must match
      if (namedEntities.size > 0) {
        const hasEntity = [...namedEntities].some((e) => candidateText.includes(e.toLowerCase()))
        if (!hasEntity) continue
      }

      if (!isAllowedTopic(`${it.title} ${it.description}`)) continue

      // Weighted score
      const totalKeywords = keywords.size
      const unigramRatio = totalKeywords > 0 ? matchedKeywords.length / totalKeywords : 0

      const matchedBigrams = titleBigrams.size > 0
        ? [...titleBigrams].filter((bg) => candidateText.includes(bg)).length
        : 0
      const bigramRatio = titleBigrams.size > 0 ? matchedBigrams / titleBigrams.size : 0

      const matchedEntities = namedEntities.size > 0
        ? [...namedEntities].filter((e) => candidateText.includes(e.toLowerCase())).length
        : 0
      const entityRatio = namedEntities.size > 0 ? matchedEntities / namedEntities.size : 0

      // If a signal type is absent, redistribute its weight to unigrams
      const unigramWeight = 0.4 + (titleBigrams.size === 0 ? 0.35 : 0) + (namedEntities.size === 0 ? 0.25 : 0)
      const bigramWeight = titleBigrams.size > 0 ? 0.35 : 0
      const entityWeight = namedEntities.size > 0 ? 0.25 : 0

      const similarityScore = Math.min(1, Math.round(
        (unigramRatio * unigramWeight + bigramRatio * bigramWeight + entityRatio * entityWeight) * 10000
      ) / 10000)

      out.push({ url: it.url, title: it.title || null, sourceDomain, matchedKeywords, similarityScore })
    }
    return out
  } catch (err) {
    console.warn(`[ReferenceCrawl] Feed fetch failed: ${feedUrl}`, err instanceof Error ? err.message : err)
    return []
  }
}
```

**Step 2: Run typecheck**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm run typecheck 2>&1
```

Expected: clean — no errors.

**Step 3: Run all tests**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm test 2>&1 | tail -40
```

Expected: all tests pass.

**Step 4: Commit**

```bash
cd /home/brandee/repos/truth-accord-background-worker && git add src/services/truthfulness/reference-sites-crawl.service.ts && git commit -m "feat: require bigram + named entity match for similar articles"
```

---

### Task 7: Update call site and raise threshold

**Files:**
- Modify: `src/workers/scrape-worker.ts`

**Step 1: Raise `MIN_SIMILARITY_TO_SAVE` constant**

Find (line 13):
```ts
const MIN_SIMILARITY_TO_SAVE = 0.2
```

Replace with:
```ts
const MIN_SIMILARITY_TO_SAVE = 0.4
```

**Step 2: Pass `scraped.content` to `getMatchingArticles`**

Find (around line 151):
```ts
const matchResult = await this.referenceSitesCrawl.getMatchingArticles(title, meta)
```

Replace with:
```ts
const matchResult = await this.referenceSitesCrawl.getMatchingArticles(title, meta, scraped.content ?? '')
```

**Step 3: Run typecheck**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm run typecheck 2>&1
```

Expected: clean.

**Step 4: Run all tests**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm test 2>&1 | tail -40
```

Expected: all tests pass.

**Step 5: Commit**

```bash
cd /home/brandee/repos/truth-accord-background-worker && git add src/workers/scrape-worker.ts && git commit -m "feat: pass full article content to similar-article matching, raise threshold to 0.4"
```

---

### Task 8: Add integration-style tests for `getMatchingArticles` scoring

**Files:**
- Modify: `src/services/truthfulness/reference-sites-crawl.test.ts`

**Step 1: Add scoring tests**

These tests verify the end-to-end weighted score by stubbing `getSites` and `fetch`.

```ts
import { mock } from 'node:test'

describe('getMatchesInFeed scoring', () => {
  it('rejects candidate with no bigram match even if unigrams match', async () => {
    // We test getMatchesInFeed indirectly by checking the output of getMatchingArticles
    // with a mocked feed. This is a structural test to confirm the hard filter works.
    // We'll unit-test the private method directly via casting.

    const getMatchesInFeed = (svc as unknown as Record<string, Function>)['getMatchesInFeed'].bind(svc)
    mock.method(globalThis, 'fetch', async () => ({
      text: async () => `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Economy policy debate heats up</title>
            <description>Policy makers discuss economic reforms</description>
            <link>https://example.com/article-1</link>
          </item>
        </channel></rss>`,
    }))

    // keywords: "economy", "policy", "debate" — but bigrams would be "economy policy", "policy debate"
    // named entities from content "Federal Reserve Board" — not in candidate → should be rejected
    const keywords = new Set(['economy', 'policy', 'debate', 'federal', 'reserve'])
    const titleBigrams = new Set(['economy policy', 'policy debate'])
    const namedEntities = new Set(['Federal Reserve Board'])

    const result: SimilarArticleItem[] = await getMatchesInFeed(
      'https://feeds.example.com/rss',
      'example.com',
      keywords,
      titleBigrams,
      namedEntities,
    )

    // Candidate has bigram "economy policy" ✓ but no entity "Federal Reserve Board" → should be filtered
    assert.equal(result.length, 0, 'should reject candidate missing named entity')

    mock.restoreAll()
  })

  it('accepts candidate with both bigram and entity match', async () => {
    const getMatchesInFeed = (svc as unknown as Record<string, Function>)['getMatchesInFeed'].bind(svc)
    mock.method(globalThis, 'fetch', async () => ({
      text: async () => `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Federal Reserve raises interest rates again</title>
            <description>Federal Reserve Board signals more rate hikes ahead in economy policy debate</description>
            <link>https://example.com/article-2</link>
          </item>
        </channel></rss>`,
    }))

    const keywords = new Set(['economy', 'policy', 'debate', 'federal', 'reserve'])
    const titleBigrams = new Set(['economy policy', 'policy debate'])
    const namedEntities = new Set(['Federal Reserve Board'])

    const result: SimilarArticleItem[] = await getMatchesInFeed(
      'https://feeds.example.com/rss',
      'example.com',
      keywords,
      titleBigrams,
      namedEntities,
    )

    assert.equal(result.length, 1, 'should accept candidate with bigram + entity match')
    assert.ok(result[0].similarityScore > 0, 'score should be positive')
    mock.restoreAll()
  })
})
```

**Step 2: Run tests**

```bash
cd /home/brandee/repos/truth-accord-background-worker && npm test 2>&1 | tail -50
```

Expected: all tests pass including the 2 new scoring tests.

**Step 3: Commit**

```bash
cd /home/brandee/repos/truth-accord-background-worker && git add src/services/truthfulness/reference-sites-crawl.test.ts && git commit -m "test: add scoring integration tests for similar article matching"
```
