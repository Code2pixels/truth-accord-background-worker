# Topic Filter & DB-Backed Reference Sites — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restrict article ingestion to Political, Science, and Educational content only; replace the `REFERENCE_SITES` hardcoded const with live DB data so trust scores can be managed from the admin UI.

**Architecture:** Keyword-based topic classifier (no deps) applied at RSS ingestion and post-scrape. Reference sites loaded from `sources.records` (new `trust_score` column) via a new repository injected into `ReferenceSitesCrawlService`. Similar-article crawl also topic-filters its results. Trust score exposed through all layers (DB → API → frontend edit form).

**Tech Stack:** TypeScript, Node.js, `pg` (raw SQL), NestJS (API), Next.js (frontend). No ORMs.

**Constraint:** User runs all migrations manually via GitHub Actions — only write the `.sql` files, never execute them. Commit everything across all four repos in a single commit at the very end.

---

## Task 1: DB migrations

**Files:**
- Create: `truth-accord-db/db/migrations/20260613000015_sources_trust_score.sql`
- Create: `truth-accord-db/db/migrations/20260613000016_seed_trust_scores.sql`

**Step 1: Add `trust_score` column**

Create `20260613000015_sources_trust_score.sql`:

```sql
-- migrate:up
ALTER TABLE sources.records
  ADD COLUMN IF NOT EXISTS trust_score NUMERIC(3,2) DEFAULT NULL;

-- migrate:down
ALTER TABLE sources.records
  DROP COLUMN IF EXISTS trust_score;
```

`trust_score IS NULL` = unrated / not a reference site. `trust_score IS NOT NULL` = used as a reference source for factual accuracy scoring.

**Step 2: Seed trust scores for known reference domains**

Create `20260613000016_seed_trust_scores.sql`. Match by the exact `url` values already in `sources.records`:

```sql
-- migrate:up
UPDATE sources.records SET trust_score = 0.92 WHERE url = 'https://apnews.com';
UPDATE sources.records SET trust_score = 0.92 WHERE url = 'https://reuters.com';
UPDATE sources.records SET trust_score = 0.86 WHERE url = 'https://npr.org';
UPDATE sources.records SET trust_score = 0.86 WHERE url = 'https://pbs.org/newshour';
UPDATE sources.records SET trust_score = 0.84 WHERE url = 'https://cbsnews.com';
UPDATE sources.records SET trust_score = 0.88 WHERE url = 'https://bbc.co.uk';
UPDATE sources.records SET trust_score = 0.84 WHERE url = 'https://dw.com';
UPDATE sources.records SET trust_score = 0.82 WHERE url = 'https://france24.com';
UPDATE sources.records SET trust_score = 0.80 WHERE url = 'https://aljazeera.com';
UPDATE sources.records SET trust_score = 0.86 WHERE url = 'https://cbc.ca/news';
UPDATE sources.records SET trust_score = 0.86 WHERE url = 'https://nytimes.com';
UPDATE sources.records SET trust_score = 0.84 WHERE url = 'https://washingtonpost.com';
UPDATE sources.records SET trust_score = 0.84 WHERE url = 'https://theguardian.com';
UPDATE sources.records SET trust_score = 0.84 WHERE url = 'https://wsj.com';
UPDATE sources.records SET trust_score = 0.86 WHERE url = 'https://economist.com';
UPDATE sources.records SET trust_score = 0.82 WHERE url = 'https://politico.com';
UPDATE sources.records SET trust_score = 0.80 WHERE url = 'https://thehill.com';
UPDATE sources.records SET trust_score = 0.86 WHERE url = 'https://bloomberg.com';
UPDATE sources.records SET trust_score = 0.80 WHERE url = 'https://cnn.com';
UPDATE sources.records SET trust_score = 0.88 WHERE url = 'https://propublica.org';
UPDATE sources.records SET trust_score = 0.90 WHERE url = 'https://nature.com';
UPDATE sources.records SET trust_score = 0.55 WHERE url = 'https://foxnews.com';

-- migrate:down
UPDATE sources.records SET trust_score = NULL
WHERE url IN (
  'https://apnews.com', 'https://reuters.com', 'https://npr.org',
  'https://pbs.org/newshour', 'https://cbsnews.com', 'https://bbc.co.uk',
  'https://dw.com', 'https://france24.com', 'https://aljazeera.com',
  'https://cbc.ca/news', 'https://nytimes.com', 'https://washingtonpost.com',
  'https://theguardian.com', 'https://wsj.com', 'https://economist.com',
  'https://politico.com', 'https://thehill.com', 'https://bloomberg.com',
  'https://cnn.com', 'https://propublica.org', 'https://nature.com',
  'https://foxnews.com'
);
```

---

## Task 2: Topic classifier (background worker)

**Files:**
- Create: `truth-accord-background-worker/src/config/topic-filter.config.ts`
- Create: `truth-accord-background-worker/src/services/topic-classifier.ts`

**Step 1: Create keyword config**

Create `src/config/topic-filter.config.ts`:

```typescript
export const TOPIC_KEYWORDS: Record<string, string[]> = {
  political: [
    'congress', 'senate', 'parliament', 'election', 'president', 'government',
    'legislation', 'policy', 'vote', 'democrat', 'republican', 'white house',
    'minister', 'treaty', 'sanctions', 'diplomat', 'campaign', 'ballot',
    'political', 'partisan', 'judiciary', 'supreme court', 'federal',
    'nato', 'geopolitics', 'foreign affairs', 'state department', 'referendum',
    'constitution', 'executive order', 'filibuster', 'impeachment', 'tariff',
  ],
  science: [
    'research', 'study', 'scientist', 'climate', 'species', 'genome', 'vaccine',
    'nasa', 'space', 'physics', 'chemistry', 'biology', 'astronomy', 'ecology',
    'evolution', 'experiment', 'laboratory', 'fossil', 'pandemic', 'virus',
    'scientific', 'discovery', 'evidence', 'peer review', 'environment',
    'carbon', 'emissions', 'renewable', 'nuclear', 'quantum', 'genome',
    'biodiversity', 'telescope', 'particle', 'enzyme', 'stem cell', 'crispr',
  ],
  education: [
    'school', 'university', 'college', 'student', 'teacher', 'professor',
    'curriculum', 'academic', 'education', 'graduation', 'scholarship',
    'tuition', 'literacy', 'learning', 'classroom', 'campus', 'faculty',
    'enrollment', 'degree', 'dissertation', 'training', 'school board',
    'standardized test', 'public school', 'charter school', 'student loan',
  ],
}
```

**Step 2: Create classifier**

Create `src/services/topic-classifier.ts`:

```typescript
import { TOPIC_KEYWORDS } from '../config/topic-filter.config.ts'

export function isAllowedTopic(text: string): boolean {
  const lower = text.toLowerCase()
  return Object.values(TOPIC_KEYWORDS).some((keywords) =>
    keywords.some((kw) => lower.includes(kw)),
  )
}
```

---

## Task 3: Reference sites repository (background worker)

**Files:**
- Create: `truth-accord-background-worker/src/repositories/reference-sites.repository.ts`

**Step 1: Write the repository**

```typescript
import { query } from '../db/client.ts'

export interface ReferenceSiteRecord {
  domain: string
  trustScore: number
  feedUrl: string
}

export class ReferenceSitesRepository {
  async findAll(): Promise<ReferenceSiteRecord[]> {
    const rows = await query<{ url: string; trust_score: number; rss_url: string }>(
      `SELECT url, trust_score, rss_url
       FROM sources.records
       WHERE trust_score IS NOT NULL AND rss_url IS NOT NULL AND is_active = TRUE`,
    )
    return rows.map((r) => ({
      domain: new URL(r.url).hostname.replace(/^www\./, ''),
      trustScore: Number(r.trust_score),
      feedUrl: r.rss_url,
    }))
  }
}
```

---

## Task 4: Update `ReferenceSitesCrawlService` — load from DB, expose `getTrustScore`, topic-filter results

**Files:**
- Modify: `truth-accord-background-worker/src/services/truthfulness/reference-sites-crawl.service.ts`

**Step 1: Replace the class**

The current class reads `REFERENCE_SITES` at module level and uses `STOP_WORDS` from `reference.config.ts`. `STOP_WORDS` moves to its own import from `topic-filter.config.ts` or stays inlined — keep it in `reference.config.ts` for now (only the `REFERENCE_SITES` const is deleted later).

Replace the entire file content:

```typescript
import { XMLParser } from 'fast-xml-parser'
import { STOP_WORDS } from '../../config/reference.config.ts'
import { isAllowedTopic } from '../topic-classifier.ts'
import type { ReferenceSitesRepository, ReferenceSiteRecord } from '../../repositories/reference-sites.repository.ts'

const MIN_WORD_LENGTH = 4
const MIN_KEYWORD_MATCH = 2
const FEED_TIMEOUT_MS = 8_000

export interface SimilarArticleItem {
  url: string
  title: string | null
  sourceDomain: string
  matchedKeywords: string[]
  similarityScore: number
}

export class ReferenceSitesCrawlService {
  private readonly parser: XMLParser
  private cachedSites: ReferenceSiteRecord[] | null = null

  constructor(private readonly referenceSitesRepo: ReferenceSitesRepository) {
    this.parser = new XMLParser({ ignoreDeclaration: true, ignoreAttributes: false, trimValues: true })
  }

  private async getSites(): Promise<ReferenceSiteRecord[]> {
    if (!this.cachedSites) {
      this.cachedSites = await this.referenceSitesRepo.findAll()
    }
    return this.cachedSites
  }

  async getTrustScore(domain: string | null | undefined): Promise<number | null> {
    if (!domain) return null
    const norm = domain.toLowerCase().trim().replace(/^www\./, '')
    const sites = await this.getSites()
    return sites.find((s) => s.domain === norm)?.trustScore ?? null
  }

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

  async searchFeedsByTerm(term: string, limit = 20): Promise<{ urls: string[]; totalFound: number }> {
    const keywords = this.getSearchTermKeywords(term)
    if (keywords.size < 1) return { urls: [], totalFound: 0 }

    const sites = await this.getSites()
    const seen = new Set<string>()
    const urls: string[] = []

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
            const matched = this.getMatchedKeywords(it.title, it.description, keywords)
            if (matched.length < 1) continue
            const url = it.url?.trim()
            if (!url || !url.startsWith('http') || seen.has(url)) continue
            seen.add(url)
            urls.push(url)
          }
        } catch (err) {
          console.warn(`[ReferenceCrawl] Feed search failed: ${site.feedUrl}`, err instanceof Error ? err.message : err)
        }
      }),
    )

    return { urls: urls.slice(0, limit), totalFound: urls.length }
  }

  private extractKeywords(title: string, meta: string): Set<string> {
    const text = [title, meta].filter(Boolean).join(' ').toLowerCase()
    const words = text.replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean)
    const set = new Set<string>()
    for (const w of words) {
      const clean = w.replace(/^['-]+|['-]+$/g, '')
      if (clean.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(clean)) set.add(clean)
    }
    return set
  }

  private getSearchTermKeywords(term: string): Set<string> {
    const text = term.trim().toLowerCase()
    if (!text) return new Set()
    const words = text.replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean)
    const set = new Set<string>()
    for (const w of words) {
      const clean = w.replace(/^['-]+|['-]+$/g, '')
      if (clean.length >= 2 && !STOP_WORDS.has(clean)) set.add(clean)
    }
    return set
  }

  private getMatchedKeywords(itemTitle: string, itemDesc: string, keywords: Set<string>): string[] {
    const text = [itemTitle, itemDesc].filter(Boolean).join(' ').toLowerCase()
    return [...keywords].filter((kw) => text.includes(kw))
  }

  private getFeedItems(xml: string): { title: string; description: string; url: string }[] {
    try {
      const parsed = this.parser.parse(xml) as Record<string, unknown>
      const items: { title: string; description: string; url: string }[] = []

      const one = (obj: unknown, tag: string): string => {
        if (typeof obj !== 'object' || obj === null || !(tag in (obj as Record<string, unknown>))) return ''
        const v = (obj as Record<string, unknown>)[tag]
        if (typeof v === 'string') return v
        if (typeof v === 'object' && v !== null && '#text' in (v as Record<string, unknown>))
          return String((v as Record<string, unknown>)['#text'] ?? '')
        return String(v ?? '')
      }

      const linkFromAtom = (obj: unknown): string => {
        const link = (obj as Record<string, unknown>).link
        const hrefFrom = (l: unknown): string => {
          if (!l || typeof l !== 'object') return ''
          const attrs = (l as Record<string, unknown>)['@_']
          if (attrs && typeof attrs === 'object' && 'href' in (attrs as object))
            return String((attrs as Record<string, string>).href ?? '')
          return ''
        }
        if (Array.isArray(link)) {
          const alt = link.find((l: unknown) => {
            const attrs = (l as Record<string, unknown>)['@_']
            return attrs && typeof attrs === 'object' && (attrs as Record<string, string>).rel !== 'self'
          })
          return hrefFrom(alt ?? link[0]) || ''
        }
        return hrefFrom(link) || ''
      }

      if (parsed.rss && typeof parsed.rss === 'object') {
        const channel = (parsed.rss as Record<string, unknown>).channel
        if (channel && typeof channel === 'object') {
          const rawItems = (channel as Record<string, unknown>).item
          const arr = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []
          for (const it of arr) {
            const t = one(it, 'title')
            const d = one(it, 'description') || one(it, 'content:encoded') || one(it, 'content')
            const url = one(it, 'link')
            if (url && url.startsWith('http')) items.push({ title: t, description: typeof d === 'string' ? d : '', url })
          }
        }
      } else if (parsed.feed && typeof parsed.feed === 'object') {
        const rawEntries = (parsed.feed as Record<string, unknown>).entry
        const arr = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : []
        for (const it of arr) {
          const t = one(it, 'title')
          const sum = (it as Record<string, unknown>).summary
          const cont = (it as Record<string, unknown>).content
          const d = typeof sum === 'string' ? sum : typeof cont === 'string' ? cont : ''
          const url = linkFromAtom(it) || one(it, 'id')
          if (url && url.startsWith('http')) items.push({ title: t, description: d, url })
        }
      }
      return items
    } catch {
      return []
    }
  }

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
}
```

---

## Task 5: Update `TruthfulnessService` — use `getTrustScore` from crawl service

**Files:**
- Modify: `truth-accord-background-worker/src/services/truthfulness/truthfulness.service.ts`

**Step 1: Make `scoreFactualAccuracy` async and use `referenceSitesCrawl.getTrustScore`**

Replace the import of `getReferenceTrustScore` and update `scoreFactualAccuracy`:

Remove the import line:
```typescript
import { getReferenceTrustScore } from './reference-sites.const.ts'
```

Update `computeScores` to await the factual accuracy call, and update `scoreFactualAccuracy`:

```typescript
// In computeScores, change:
const factualAccuracy = this.scoreFactualAccuracy(input)
// to:
const factualAccuracy = await this.scoreFactualAccuracy(input)
```

```typescript
// Change scoreFactualAccuracy signature and body:
private async scoreFactualAccuracy(input: TruthfulnessInput): Promise<number> {
  const words = input.wordCount ?? 0
  const hasBody = words >= 100
  const hasMeta = Boolean(input.metaDescription?.trim())
  const siteTrust = await this.referenceSitesCrawl.getTrustScore(input.sourceDomain)
  if (siteTrust != null) {
    let score = siteTrust
    if (hasBody && hasMeta) score = Math.min(1, score + 0.05)
    else if (hasBody) score = Math.min(1, score + 0.02)
    return Math.round(score * 100) / 100
  }
  if (hasBody && hasMeta) return 0.65
  if (hasBody) return 0.55
  return 0.45
}
```

---

## Task 6: RSS feed worker — extract title/description and topic-filter before queuing

**Files:**
- Modify: `truth-accord-background-worker/src/workers/rss-feed.worker.ts`

**Step 1: Add `title` and `description` to `FeedItem` interface**

```typescript
interface FeedItem {
  title?: string | { '#text': string }
  description?: string | { '#text': string }
  summary?: string | { '#text': string }
  link?: string | { '#text': string } | Array<{ '@_rel'?: string; '@_href'?: string } | string>
  guid?: string | { '#text': string }
  id?: string
}
```

**Step 2: Add `extractText` helper after the existing `extractUrl` function**

```typescript
function extractText(val: string | { '#text': string } | undefined): string {
  if (!val) return ''
  if (typeof val === 'string') return val
  return val['#text'] ?? ''
}
```

**Step 3: Add import for `isAllowedTopic` at the top of the file**

```typescript
import { isAllowedTopic } from '../services/topic-classifier.ts'
```

**Step 4: Apply the filter inside the per-item loop in `run()`**

Find this block inside the `for (const item of items)` loop:
```typescript
const raw = extractUrl(item)
if (!raw) continue
```

Add the topic check immediately after:
```typescript
const raw = extractUrl(item)
if (!raw) continue
const topicText = `${extractText(item.title)} ${extractText(item.description ?? item.summary)}`
if (!isAllowedTopic(topicText)) continue
```

---

## Task 7: Scrape worker — topic-filter after scrape, before article insert

**Files:**
- Modify: `truth-accord-background-worker/src/workers/scrape-worker.ts`

**Step 1: Add import for `isAllowedTopic`**

```typescript
import { isAllowedTopic } from '../services/topic-classifier.ts'
```

**Step 2: Insert topic check between step 3 and step 4 in `processJob`**

Find the log line for step 4:
```typescript
// Step 4: Upsert article
console.log(`[Job ${id}] [4/6] Upserting article record...`)
```

Insert before it (making this step 4 and shifting prior step 4 onward — update the `[N/6]` labels to `[N/7]` throughout):

```typescript
// Step 4: Topic filter
const topicText = [scraped.title, scraped.metaDescription, scraped.content].filter(Boolean).join(' ')
if (!isAllowedTopic(topicText)) {
  console.log(`[Job ${id}] [4/7] Off-topic — skipping insert`)
  await this.workerJobsRepo.updateStatus(id, 'completed')
  console.log(`[Job ${id}] ── SKIPPED (off-topic) [${Date.now() - t0}ms] ──`)
  return
}
console.log(`[Job ${id}] [4/7] Topic check passed`)
```

Also update the `[N/6]` step labels in the rest of `processJob` to `[N/7]` to keep the numbering consistent.

---

## Task 8: Wire up `ReferenceSitesRepository` in `index.ts` and delete the static const files

**Files:**
- Modify: `truth-accord-background-worker/src/index.ts`
- Modify: `truth-accord-background-worker/src/config/reference.config.ts` (remove `REFERENCE_SITES`, keep `STOP_WORDS`)
- Delete: `truth-accord-background-worker/src/services/truthfulness/reference-sites.const.ts`

**Step 1: Add `ReferenceSitesRepository` to `index.ts`**

Add import:
```typescript
import { ReferenceSitesRepository } from './repositories/reference-sites.repository.ts'
```

Add instantiation in the Repositories block:
```typescript
const referenceSitesRepo = new ReferenceSitesRepository()
```

Update `ReferenceSitesCrawlService` construction (currently takes no args):
```typescript
// Before:
const referenceSitesCrawl = new ReferenceSitesCrawlService()
// After:
const referenceSitesCrawl = new ReferenceSitesCrawlService(referenceSitesRepo)
```

**Step 2: Trim `reference.config.ts` — remove `REFERENCE_SITES`, keep `STOP_WORDS`**

Delete everything except the `STOP_WORDS_LIST` array and the `STOP_WORDS` export. The file should become:

```typescript
const STOP_WORDS_LIST = [
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'his',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'how', 'its', 'may', 'new',
  'now', 'old', 'see', 'way', 'who', 'did', 'has', 'her', 'him', 'his', 'say', 'she',
  'too', 'use', 'that', 'with', 'this', 'from', 'have', 'will', 'your', 'they', 'been',
  'more', 'when', 'would', 'there', 'their', 'what', 'about', 'which', 'could', 'should',
  'if', 'on', 'in', 'an', 'at', 'as', 'it', 'so', 'by', 'do', 'to', 'of', 'a', 'is', 'or',
  'be', 'no', 'up', 'down', 'over', 'under', 'into', 'out', 'before', 'after', 'off',
  'just', 'like', 'than', 'then', 'such', 'these', 'those', 'them', 'very', 'much',
  'any', 'each', 'other', 'some', 'also', 'were', 'because',
]

export const STOP_WORDS = new Set(STOP_WORDS_LIST)
```

**Step 3: Delete `reference-sites.const.ts`**

```bash
rm truth-accord-background-worker/src/services/truthfulness/reference-sites.const.ts
```

**Step 4: Run typecheck to confirm no dangling imports**

```bash
cd truth-accord-background-worker && npm run typecheck
```

Expected: no errors. If any file still imports from `reference-sites.const.ts` or `reference.config.ts` (the removed exports), fix them now.

---

## Task 9: API — add `trust_score` to source layer

**Files:**
- Modify: `truth-accord-api/src/common/interfaces/source.interface.ts`
- Modify: `truth-accord-api/src/common/dtos/source.dto.ts`
- Modify: `truth-accord-api/src/sources/sources.repository.ts`

**Step 1: Update `ISource` interface**

```typescript
export interface ISource {
  id: string;
  name: string;
  url: string;
  rss_url: string;
  is_active: boolean;
  trust_score: number | null;
  created_at: Date;
  updated_at: Date;
}
```

**Step 2: Add `trust_score` to `UpdateSourceDto`**

Add `IsNumber` and `Min`, `Max` to the existing import from `class-validator`:
```typescript
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';
```

Add the field to `UpdateSourceDto`:
```typescript
@IsNumber()
@Min(0)
@Max(1)
@IsOptional()
trust_score?: number | null;
```

**Step 3: Update `sources.repository.ts`**

Add `trust_score` to every `SELECT` list (3 places: `findAll`, `findTop`, and the re-fetch after update):

```sql
-- findAll
SELECT id, name, url, rss_url, is_active, trust_score, created_at, updated_at
FROM sources.records ORDER BY name ASC

-- findTop
SELECT s.id, s.name, s.url, s.rss_url, s.is_active, s.trust_score, s.created_at, s.updated_at, ...

-- re-fetch after update
SELECT id, name, url, rss_url, is_active, trust_score, created_at, updated_at
FROM sources.records WHERE id = $1
```

Add `trust_score` to the `update` dynamic builder. After the existing `is_active` block:
```typescript
if (dto.trust_score !== undefined) { fields.push(`trust_score = $${idx++}`); values.push(dto.trust_score); }
```

**Step 4: Typecheck the API**

```bash
cd truth-accord-api && npm run build -- --noEmit 2>&1 | head -30
```

Expected: clean.

---

## Task 10: Frontend — expose `trust_score` in sources table and edit form

**Files:**
- Modify: `truth-accord-frontend/src/types/index.ts`
- Modify: `truth-accord-frontend/src/lib/apiClient.ts`
- Modify: `truth-accord-frontend/src/app/manage/page.tsx`

**Step 1: Add `trust_score` to `ISource` type**

In `src/types/index.ts`, update `ISource`:
```typescript
export interface ISource {
  id: string;
  name: string;
  url: string;
  rss_url: string;
  is_active: boolean;
  trust_score: number | null;
  created_at: string;
  updated_at: string;
}
```

**Step 2: Add `trust_score` to `updateSource` in `apiClient.ts`**

```typescript
updateSource: (id: string, body: Partial<{ name: string; url: string; rss_url: string; is_active: boolean; trust_score: number | null }>) =>
```

**Step 3: Update `manage/page.tsx`**

Add `trust_score` to `editForm` state type and initial values. Find:
```typescript
const [editForm, setEditForm] = useState({ name: '', url: '', rss_url: '' });
```
Change to:
```typescript
const [editForm, setEditForm] = useState<{ name: string; url: string; rss_url: string; trust_score: string }>({ name: '', url: '', rss_url: '', trust_score: '' });
```

Add "Trust" column header. Find the existing headers array:
```typescript
{['Name', 'URL', 'RSS URL', 'Active', 'Actions'].map(h => (
```
Change to:
```typescript
{['Name', 'URL', 'RSS URL', 'Trust', 'Active', 'Actions'].map(h => (
```

In the non-edit row, add a trust score cell after the RSS URL cell and before the active cell:
```tsx
<td className="py-3 pr-4 font-code text-[12px] text-ta-text2">
  {s.trust_score != null ? s.trust_score.toFixed(2) : '—'}
</td>
```

In the edit row, add a trust score input cell after the RSS URL input and before the empty active cell:
```tsx
<td className="py-2 pr-2">
  <input
    type="number"
    step="0.01"
    min="0"
    max="1"
    placeholder="0.00"
    value={editForm.trust_score}
    onChange={e => setEditForm(f => ({ ...f, trust_score: e.target.value }))}
    className="font-code text-[12px] border border-ta-border rounded px-2 py-1 bg-ta-surface2 text-ta-text1 w-20"
  />
</td>
```

Update the Edit button `onClick` to populate `trust_score` in the form:
```typescript
onClick={() => {
  setEditingSource(s);
  setEditForm({ name: s.name, url: s.url, rss_url: s.rss_url, trust_score: s.trust_score != null ? String(s.trust_score) : '' });
}}
```

Update the Save button `onClick` to include `trust_score` in the payload:
```typescript
await adminProxyClient.updateSource(s.id, {
  ...editForm,
  trust_score: editForm.trust_score !== '' ? parseFloat(editForm.trust_score) : null,
});
```

**Step 4: Typecheck the frontend**

```bash
cd truth-accord-frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: clean.

---

## Task 11: Final commit (all four repos)

**Step 1: Stage and commit `truth-accord-db`**

```bash
cd truth-accord-db
git add db/migrations/20260613000015_sources_trust_score.sql
git add db/migrations/20260613000016_seed_trust_scores.sql
git commit -m "feat: add trust_score column to sources.records and seed reference site scores

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

**Step 2: Stage and commit `truth-accord-background-worker`**

```bash
cd truth-accord-background-worker
git add src/config/topic-filter.config.ts
git add src/config/reference.config.ts
git add src/services/topic-classifier.ts
git add src/repositories/reference-sites.repository.ts
git add src/services/truthfulness/reference-sites-crawl.service.ts
git add src/services/truthfulness/truthfulness.service.ts
git add src/workers/rss-feed.worker.ts
git add src/workers/scrape-worker.ts
git add src/index.ts
git rm src/services/truthfulness/reference-sites.const.ts
git commit -m "feat: topic filter allowlist and DB-backed reference sites

- Add Political/Science/Education keyword allowlist classifier
- Filter articles at RSS ingestion and post-scrape before insert
- Filter similar articles in reference crawl by topic
- Load reference sites (trust_score, feed URLs) from DB instead of const
- ReferenceSitesCrawlService takes ReferenceSitesRepository; lazy-loads on first call
- TruthfulnessService.scoreFactualAccuracy uses getTrustScore from crawl service
- Delete REFERENCE_SITES const and reference-sites.const.ts

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

**Step 3: Stage and commit `truth-accord-api`**

```bash
cd truth-accord-api
git add src/common/interfaces/source.interface.ts
git add src/common/dtos/source.dto.ts
git add src/sources/sources.repository.ts
git commit -m "feat: expose trust_score on source records via API

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

**Step 4: Stage and commit `truth-accord-frontend`**

```bash
cd truth-accord-frontend
git add src/types/index.ts
git add src/lib/apiClient.ts
git add src/app/manage/page.tsx
git commit -m "feat: add trust score field to manage sources UI

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
