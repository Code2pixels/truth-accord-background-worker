# RSS Category-Based Topic Classification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the boolean `isAllowedTopic()` filter with a `classifyTopic()` function that returns a normalized category name, use RSS `<category>` tags as the primary classification signal, and store the resolved category on each article record.

**Architecture:** Two-stage classification — the RSS worker uses feed category tags (via a `CATEGORY_ALIASES` map) with keyword fallback to decide whether to queue a job; the scrape worker re-classifies from full scraped content and stores the authoritative category on the article. A DB migration adds a `category` column to `articles.records`.

**Tech Stack:** TypeScript, Node.js, fast-xml-parser (already used), pg via DatabaseService, dbmate migrations

---

### Task 1: DB migration — add `category` column

**Files:**
- Create: `truth-accord-db/db/migrations/20260614000017_articles_category.sql`

**Step 1: Create the migration file**

```sql
-- migrate:up
ALTER TABLE articles.records ADD COLUMN category VARCHAR(50);

-- migrate:down
ALTER TABLE articles.records DROP COLUMN category;
```

**Step 2: Commit**

```bash
git -C /home/brandee/repos/truth-accord-db add db/migrations/20260614000017_articles_category.sql
git -C /home/brandee/repos/truth-accord-db commit -m "feat: add category column to articles.records"
```

> Note: Do NOT run the migration. The user runs migrations manually via GitHub Actions.

---

### Task 2: Expand topic config with categories and aliases

**Files:**
- Modify: `src/config/topic-filter.config.ts`

**Step 1: Replace the entire file contents**

```typescript
export const TOPIC_KEYWORDS: Record<string, string[]> = {
  politics: [
    'congress', 'senate', 'parliament', 'election', 'president', 'government',
    'legislation', 'policy', 'vote', 'democrat', 'republican', 'white house',
    'minister', 'treaty', 'sanctions', 'diplomat', 'campaign', 'ballot',
    'political', 'partisan', 'judiciary', 'supreme court', 'federal',
    'nato', 'geopolitics', 'foreign affairs', 'state department', 'referendum',
    'constitution', 'executive order', 'filibuster', 'impeachment', 'tariff',
    'governor', 'mayor', 'municipality', 'bill', 'lobbying', 'primary',
    'midterm', 'inauguration', 'veto', 'bipartisan', 'caucus',
  ],
  economics: [
    'economy', 'gdp', 'inflation', 'recession', 'interest rate', 'federal reserve',
    'stock market', 'wall street', 'investment', 'trade deficit', 'budget',
    'tax', 'fiscal', 'monetary', 'bond', 'equity', 'fund', 'earnings',
    'employment', 'unemployment', 'labor market', 'wage', 'debt', 'deficit',
    'export', 'import', 'supply chain', 'market', 'merger', 'acquisition',
    'ipo', 'startup', 'venture capital', 'revenue', 'profit', 'cryptocurrency',
    'banking', 'financial', 'economic', 'business', 'corporation', 'trade',
  ],
  science: [
    'research', 'study', 'scientist', 'climate', 'species', 'genome', 'vaccine',
    'nasa', 'space', 'physics', 'chemistry', 'biology', 'astronomy', 'ecology',
    'evolution', 'experiment', 'laboratory', 'fossil', 'pandemic', 'virus',
    'scientific', 'discovery', 'evidence', 'peer review',
    'carbon', 'emissions', 'renewable', 'nuclear', 'quantum',
    'biodiversity', 'telescope', 'particle', 'enzyme', 'stem cell', 'crispr',
    'neuroscience', 'geology', 'meteorology', 'oceanography', 'genetics',
  ],
  health: [
    'health', 'disease', 'hospital', 'doctor', 'patient', 'treatment', 'medicine',
    'drug', 'pharmaceutical', 'fda', 'cdc', 'who', 'public health', 'epidemic',
    'cancer', 'diabetes', 'heart', 'mental health', 'therapy', 'surgery',
    'clinical trial', 'diagnosis', 'symptom', 'infection', 'antibiotics',
    'healthcare', 'medicaid', 'medicare', 'insurance', 'wellness', 'nutrition',
    'obesity', 'opioid', 'mortality', 'life expectancy', 'aging', 'pediatric',
  ],
  technology: [
    'artificial intelligence', 'machine learning', 'software', 'hardware',
    'cybersecurity', 'data breach', 'privacy', 'algorithm', 'silicon valley',
    'tech', 'internet', 'cloud', 'smartphone', 'app', 'platform', 'social media',
    'automation', 'robot', 'autonomous', 'semiconductor', 'chip', 'quantum computing',
    'blockchain', 'encryption', 'open source', 'api', 'startup tech',
    'elon musk', 'google', 'apple', 'microsoft', 'amazon', 'meta', 'nvidia',
    'broadband', '5g', 'electric vehicle', 'battery', 'drone',
  ],
  education: [
    'school', 'university', 'college', 'student', 'teacher', 'professor',
    'curriculum', 'academic', 'education', 'graduation', 'scholarship',
    'tuition', 'literacy', 'learning', 'classroom', 'campus', 'faculty',
    'enrollment', 'degree', 'dissertation', 'training', 'school board',
    'standardized test', 'public school', 'charter school', 'student loan',
    'higher education', 'stem', 'preschool', 'special education', 'remote learning',
  ],
  law: [
    'court', 'judge', 'lawsuit', 'verdict', 'trial', 'attorney', 'prosecutor',
    'defendant', 'plaintiff', 'indictment', 'conviction', 'sentence', 'appeal',
    'regulation', 'compliance', 'antitrust', 'legislation', 'statute', 'legal',
    'supreme court', 'circuit court', 'district court', 'doj', 'fbi', 'dea',
    'criminal', 'civil rights', 'class action', 'settlement', 'subpoena',
    'warrant', 'parole', 'prison', 'incarceration', 'bail', 'extradition',
  ],
  environment: [
    'climate change', 'global warming', 'deforestation', 'wildfire', 'drought',
    'flood', 'hurricane', 'sea level', 'arctic', 'glacier', 'coral reef',
    'pollution', 'plastic', 'recycling', 'sustainability', 'conservation',
    'endangered species', 'habitat', 'ecosystem', 'carbon footprint', 'net zero',
    'epa', 'paris agreement', 'clean energy', 'solar', 'wind power',
    'natural disaster', 'earthquake', 'tornado', 'weather', 'atmosphere',
  ],
  world: [
    'ukraine', 'russia', 'china', 'middle east', 'europe', 'africa', 'asia',
    'united nations', 'un security council', 'war', 'conflict', 'ceasefire',
    'refugee', 'migration', 'asylum', 'terrorism', 'coup', 'protest',
    'sanctions', 'ambassador', 'embassy', 'bilateral', 'multilateral',
    'g7', 'g20', 'imf', 'world bank', 'wto', 'opec',
    'israel', 'iran', 'north korea', 'taiwan', 'india', 'brazil', 'mexico',
  ],
  society: [
    'race', 'racism', 'civil rights', 'discrimination', 'inequality', 'poverty',
    'immigration', 'border', 'diversity', 'gender', 'lgbtq', 'abortion',
    'religion', 'culture', 'demographics', 'census', 'social', 'community',
    'housing', 'homelessness', 'minimum wage', 'union', 'strike', 'labor',
    'crime', 'gun violence', 'shooting', 'police', 'criminal justice', 'reform',
    'family', 'childcare', 'welfare', 'social security', 'veterans',
  ],
}

// Maps publisher-supplied category strings (lowercased) to our normalized category names.
// Add entries here as new RSS sources expose new category names.
export const CATEGORY_ALIASES: Record<string, string> = {
  // Politics
  'politics': 'politics',
  'political': 'politics',
  'us': 'politics',
  'us-politics': 'politics',
  'government': 'politics',
  'elections': 'politics',
  'policy': 'politics',
  'white-house': 'politics',
  'congress': 'politics',
  'washington': 'politics',

  // Economics / Business
  'economics': 'economics',
  'economy': 'economics',
  'business': 'economics',
  'finance': 'economics',
  'financial': 'economics',
  'markets': 'economics',
  'money': 'economics',
  'investing': 'economics',
  'stocks': 'economics',
  'trade': 'economics',
  'companies': 'economics',
  'entrepreneurship': 'economics',

  // Science
  'science': 'science',
  'scientific': 'science',
  'space': 'science',
  'climate': 'science',
  'research': 'science',
  'biology': 'science',
  'physics': 'science',

  // Health
  'health': 'health',
  'medicine': 'health',
  'medical': 'health',
  'healthcare': 'health',
  'wellness': 'health',
  'pharma': 'health',
  'public-health': 'health',

  // Technology
  'technology': 'technology',
  'tech': 'technology',
  'ai': 'technology',
  'artificial-intelligence': 'technology',
  'cybersecurity': 'technology',
  'software': 'technology',
  'gadgets': 'technology',
  'internet': 'technology',
  'startups': 'technology',
  'innovation': 'technology',

  // Education
  'education': 'education',
  'schools': 'education',
  'learning': 'education',
  'academia': 'education',

  // Law
  'law': 'law',
  'legal': 'law',
  'courts': 'law',
  'justice': 'law',
  'crime': 'law',
  'regulation': 'law',

  // Environment
  'environment': 'environment',
  'climate-change': 'environment',
  'sustainability': 'environment',
  'energy': 'environment',
  'nature': 'environment',
  'conservation': 'environment',

  // World / International
  'world': 'world',
  'international': 'world',
  'foreign': 'world',
  'global': 'world',
  'geopolitics': 'world',
  'war': 'world',
  'conflict': 'world',
  'middle-east': 'world',
  'europe': 'world',
  'asia': 'world',
  'africa': 'world',
  'americas': 'world',

  // Society / Culture
  'society': 'society',
  'culture': 'society',
  'social': 'society',
  'race': 'society',
  'immigration': 'society',
  'religion': 'society',
  'gender': 'society',
  'labor': 'society',
  'lifestyle': 'society',
  'community': 'society',
}
```

**Step 2: Commit**

```bash
git add src/config/topic-filter.config.ts
git commit -m "feat: expand topic keywords to 10 categories and add CATEGORY_ALIASES map"
```

---

### Task 3: Rewrite topic-classifier to return category name

**Files:**
- Modify: `src/services/topic-classifier.ts`
- Create: `src/services/topic-classifier.test.ts`

**Step 1: Write the failing tests**

Create `src/services/topic-classifier.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTopic, isAllowedTopic } from './topic-classifier.ts'

describe('classifyTopic', () => {
  it('returns category from RSS alias when provided', () => {
    assert.equal(classifyTopic('some text', ['Markets']), 'economics')
  })

  it('alias matching is case-insensitive', () => {
    assert.equal(classifyTopic('some text', ['POLITICS']), 'politics')
  })

  it('falls back to keyword scan when alias has no match', () => {
    assert.equal(classifyTopic('the senate passed a new bill today', ['unknown-category']), 'politics')
  })

  it('falls back to keyword scan when no rssCategories provided', () => {
    assert.equal(classifyTopic('nasa discovers new exoplanet'), 'science')
  })

  it('returns null for off-topic text', () => {
    assert.equal(classifyTopic('buy cheap sneakers on sale'), null)
  })

  it('returns null for empty string', () => {
    assert.equal(classifyTopic(''), null)
  })

  it('prefers first matching category from aliases array', () => {
    const result = classifyTopic('text', ['unknown', 'tech'])
    assert.equal(result, 'technology')
  })
})

describe('isAllowedTopic', () => {
  it('returns true for allowed topic', () => {
    assert.equal(isAllowedTopic('the supreme court ruled today'), true)
  })

  it('returns false for off-topic text', () => {
    assert.equal(isAllowedTopic('best pizza recipes'), false)
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/brandee/repos/truth-accord-background-worker
npm test -- --test-name-pattern="classifyTopic|isAllowedTopic"
```

Expected: errors because `classifyTopic` is not exported yet.

**Step 3: Rewrite `src/services/topic-classifier.ts`**

```typescript
import { CATEGORY_ALIASES, TOPIC_KEYWORDS } from '../config/topic-filter.config.ts'

export function classifyTopic(text: string, rssCategories?: string[]): string | null {
  if (rssCategories?.length) {
    for (const raw of rssCategories) {
      const normalized = CATEGORY_ALIASES[raw.toLowerCase().trim()]
      if (normalized) return normalized
    }
  }

  const lower = text.toLowerCase()
  for (const [category, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return category
  }

  return null
}

export function isAllowedTopic(text: string): boolean {
  return classifyTopic(text) !== null
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --test-name-pattern="classifyTopic|isAllowedTopic"
```

Expected: all pass.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/services/topic-classifier.ts src/services/topic-classifier.test.ts
git commit -m "feat: replace isAllowedTopic with classifyTopic returning category name"
```

---

### Task 4: Add `category` to types and ArticleRow

**Files:**
- Modify: `src/types.ts`

**Step 1: Add `category` to `CreateArticleInput` and `ArticleRow`**

In `CreateArticleInput`, add after `status?`:
```typescript
category?: string | null
```

In `ArticleRow`, add after `status`:
```typescript
category: string | null
```

**Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: errors about missing `category` in `articles.repository.ts` upsert — that's the next task.

**Step 3: Commit** (after repository task passes typecheck)

Hold commit until Task 5 is done so typecheck is clean.

---

### Task 5: Include `category` in the articles repository upsert

**Files:**
- Modify: `src/repositories/articles.repository.ts`

**Step 1: Update the upsert SQL and params**

Replace the existing `upsert` method body:

```typescript
async upsert(input: CreateArticleInput): Promise<ArticleRow> {
  const sourceDomain = input.sourceDomain ?? new URL(input.url).hostname
  const sourceUrl = (() => { try { const u = new URL(input.url); return `${u.protocol}//${u.host}` } catch { return input.url } })()

  const row = await queryOne<ArticleRow>(
    `INSERT INTO articles.records (
      url, title, summary, authored_by, source, source_url,
      published_at, is_archived, snapshot_timestamp, word_count, status, category
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (url) DO UPDATE SET
      title              = EXCLUDED.title,
      summary            = EXCLUDED.summary,
      authored_by        = EXCLUDED.authored_by,
      source             = EXCLUDED.source,
      source_url         = EXCLUDED.source_url,
      published_at       = EXCLUDED.published_at,
      is_archived        = EXCLUDED.is_archived,
      snapshot_timestamp = EXCLUDED.snapshot_timestamp,
      word_count         = EXCLUDED.word_count,
      category           = EXCLUDED.category,
      recorded_at        = NOW()
    RETURNING *`,
    [
      input.url,
      input.title ?? '',
      input.metaDescription ?? '',
      input.author ?? '',
      sourceDomain,
      sourceUrl,
      input.publishedAt ?? null,
      input.isArchived,
      input.snapshotTimestamp ?? null,
      input.wordCount ?? null,
      input.status ?? 'pending',
      input.category ?? null,
    ],
  )
  if (!row) throw new Error(`Failed to upsert article: ${input.url}`)
  return row
}
```

**Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Commit types + repository together**

```bash
git add src/types.ts src/repositories/articles.repository.ts
git commit -m "feat: add category field to CreateArticleInput and articles upsert"
```

---

### Task 6: Parse RSS categories in rss-feed.worker.ts

**Files:**
- Modify: `src/workers/rss-feed.worker.ts`

**Step 1: Add `category` to `FeedItem` interface**

```typescript
interface FeedItem {
  title?: string | { '#text': string }
  description?: string | { '#text': string }
  summary?: string | { '#text': string }
  link?: string | { '#text': string } | Array<{ '@_rel'?: string; '@_href'?: string } | string>
  guid?: string | { '#text': string }
  id?: string
  category?: string | string[] | { '@_term'?: string } | Array<{ '@_term'?: string }>
}
```

**Step 2: Add `extractCategories` helper function** (add after `extractUrl`):

```typescript
function extractCategories(item: FeedItem): string[] {
  const { category } = item
  if (!category) return []

  const toStr = (c: string | { '@_term'?: string }): string | null => {
    if (typeof c === 'string') return c
    return c['@_term'] ?? null
  }

  if (Array.isArray(category)) {
    return category.flatMap((c) => { const s = toStr(c); return s ? [s] : [] })
  }
  const s = toStr(category)
  return s ? [s] : []
}
```

**Step 3: Update the topic check inside the feed processing loop**

Replace this block:
```typescript
const topicText = `${extractText(item.title)} ${extractText(item.description ?? item.summary)}`
if (!isAllowedTopic(topicText)) continue
```

With:
```typescript
const rssCategories = extractCategories(item)
const topicText = `${extractText(item.title)} ${extractText(item.description ?? item.summary)}`
if (!isAllowedTopic(topicText, rssCategories)) continue
```

**Step 4: Update the `isAllowedTopic` import to include the new signature**

The import at the top stays the same — `isAllowedTopic` already accepts an optional second arg after Task 3. But update the call to pass `rssCategories`:

In `topic-classifier.ts`, the `isAllowedTopic` wrapper only takes `text`. We need it to also accept `rssCategories`. Update `topic-classifier.ts`:

```typescript
export function isAllowedTopic(text: string, rssCategories?: string[]): boolean {
  return classifyTopic(text, rssCategories) !== null
}
```

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/workers/rss-feed.worker.ts src/services/topic-classifier.ts
git commit -m "feat: parse RSS category tags and pass to topic classifier"
```

---

### Task 7: Use classifyTopic in scrape-worker and store category on article

**Files:**
- Modify: `src/workers/scrape-worker.ts`

**Step 1: Update the import**

Change:
```typescript
import { isAllowedTopic } from '../services/topic-classifier.ts'
```

To:
```typescript
import { classifyTopic } from '../services/topic-classifier.ts'
```

**Step 2: Replace the topic filter block (Step 4 in processJob)**

Replace:
```typescript
const topicText = [scraped.title, scraped.metaDescription, scraped.content].filter(Boolean).join(' ')
if (!isAllowedTopic(topicText)) {
  console.log(`[Job ${id}] [4/7] Off-topic — skipping insert`)
  await this.workerJobsRepo.updateStatus(id, 'completed')
  console.log(`[Job ${id}] ── SKIPPED (off-topic) [${Date.now() - t0}ms] ──`)
  return
}
console.log(`[Job ${id}] [4/7] Topic check passed`)
```

With:
```typescript
const topicText = [scraped.title, scraped.metaDescription, scraped.content].filter(Boolean).join(' ')
const articleCategory = classifyTopic(topicText)
if (!articleCategory) {
  console.log(`[Job ${id}] [4/7] Off-topic — skipping insert`)
  await this.workerJobsRepo.updateStatus(id, 'completed')
  console.log(`[Job ${id}] ── SKIPPED (off-topic) [${Date.now() - t0}ms] ──`)
  return
}
console.log(`[Job ${id}] [4/7] Topic check passed — category: ${articleCategory}`)
```

**Step 3: Pass category to article upsert**

In the upsert call, add `category: articleCategory` after `status`:

```typescript
const article = await this.articles.upsert({
  url: scraped.url,
  title: scraped.title,
  author: scraped.author,
  publishedAt: scraped.publishedAt,
  sourceDomain,
  isArchived: scraped.isArchived,
  snapshotTimestamp: scraped.snapshotTimestamp,
  metaDescription: scraped.metaDescription,
  wordCount: scraped.wordCount,
  status: articleStatus,
  category: articleCategory,
})
```

**Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 5: Run all tests**

```bash
npm test
```

Expected: all pass.

**Step 6: Commit**

```bash
git add src/workers/scrape-worker.ts
git commit -m "feat: classify article topic category and store on article record"
```

---

## Verification Checklist

- [ ] Migration file exists in `truth-accord-db/db/migrations/20260614000017_articles_category.sql`
- [ ] `npm run typecheck` passes with no errors
- [ ] `npm test` passes (topic-classifier tests green)
- [ ] `classifyTopic('senate passed a bill')` returns `'politics'`
- [ ] `classifyTopic('', ['markets'])` returns `'economics'` (alias hit with no text)
- [ ] `classifyTopic('buy cheap sneakers')` returns `null`
- [ ] Scrape worker logs `category: <name>` on topic pass
- [ ] Scrape worker upsert includes `category` field
