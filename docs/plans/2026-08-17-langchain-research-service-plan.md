# LangChain Research Service Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all AI work out of the TypeScript worker into a new Python LangChain/LangGraph service that researches each article's author, publication ownership, citations, publication history and corroboration, communicating only through the existing Postgres job queue.

**Architecture:** The TS worker becomes a pure scraper: it scrapes, stores body text and outbound links, inserts the article as `pending`, and enqueues a `research_article` job. A new Python service (`truth-accord-research`) claims those jobs with `FOR UPDATE SKIP LOCKED`, runs a LangGraph pipeline of research nodes against a local Ollama, and writes category, scores, similar articles, author and ownership entities back to Postgres in one transaction.

**Tech Stack:** TypeScript (existing worker: node:test, pg, cheerio) · Python 3.12 (uv, LangChain, LangGraph, langchain-ollama, pydantic v2, psycopg 3, httpx, BeautifulSoup4, trafilatura, pytest, respx, ruff) · PostgreSQL migrations via dbmate.

**Design doc:** `docs/plans/2026-08-17-langchain-research-service-design.md`

---

## Prerequisites

Before Task 1, confirm the following and stop if any is missing.

1. A scratch Postgres you can migrate freely. If you do not have one:
   ```bash
   docker run -d --name ta-test-db -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
   export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5433/postgres"
   ```
2. `dbmate` on PATH (see `truth-accord-db/README.md`).
3. `uv` on PATH: `curl -LsSf https://astral.sh/uv/install.sh | sh`
4. A reachable Ollama with `gemma4` and `nomic-embed-text` pulled. The value in `.env` is `http://10.13.37.54:30068`. Verify:
   ```bash
   curl -s http://10.13.37.54:30068/api/tags | head -c 400
   ```
   If it is unreachable, every task in Phases 3 and 4 still works — their tests use a fake chat model — but the parity run in Task 33 cannot be done.

**Repos involved**

| Repo | Path | Role |
|---|---|---|
| `truth-accord-db` | `/home/brandee/repos/truth-accord-db` | migrations |
| `truth-accord-background-worker` | `/home/brandee/repos/truth-accord-background-worker` | TS scraper worker |
| `truth-accord-research` | `/home/brandee/repos/truth-accord-research` | **new**, Python research service |

Commit in the repo you are touching. Never mix repos in one commit.

---

# Phase 0 — Database migrations

All files go in `/home/brandee/repos/truth-accord-db/db/migrations/`. Apply each one as you write it, then roll it back and re-apply, to prove the down block works.

Standard verification loop used by every task in this phase:

```bash
cd /home/brandee/repos/truth-accord-db
export DATABASE_URL="$TEST_DATABASE_URL"
psql "$DATABASE_URL" -c "CREATE SCHEMA IF NOT EXISTS migrations;"
dbmate --migrations-table migrations.schema_migrations --migrations-dir db/migrations up
dbmate --migrations-table migrations.schema_migrations --migrations-dir db/migrations rollback
dbmate --migrations-table migrations.schema_migrations --migrations-dir db/migrations up
```

### Task 1: Article body and outbound links table

**Files:**
- Create: `db/migrations/20260817000021_articles_content.sql`

**Step 1: Write the migration**

```sql
-- migrate:up
CREATE TABLE IF NOT EXISTS articles.content (
  article_id  UUID PRIMARY KEY REFERENCES articles.records (id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  links       JSONB NOT NULL DEFAULT '[]',
  char_count  INTEGER NOT NULL DEFAULT 0,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN articles.content.links IS
  'Outbound links extracted at scrape time: [{"url":"...","anchor":"...","rel":"..."}]';

-- migrate:down
DROP TABLE IF EXISTS articles.content;
```

**Step 2: Apply and verify**

Run the standard verification loop, then:
```bash
psql "$DATABASE_URL" -c "\d articles.content"
```
Expected: table exists with `article_id` primary key and `links` of type `jsonb`.

**Step 3: Commit**

```bash
git add db/migrations/20260817000021_articles_content.sql
git commit -m "feat(db): add articles.content for body text and outbound links"
```

### Task 2: Publication ownership table

**Files:**
- Create: `db/migrations/20260817000022_sources_ownership.sql`

**Step 1: Write the migration**

```sql
-- migrate:up
CREATE TABLE IF NOT EXISTS sources.ownership (
  domain            TEXT PRIMARY KEY,
  owner_name        TEXT,
  parent_org        TEXT,
  owner_group_key   TEXT,
  ownership_chain   JSONB NOT NULL DEFAULT '[]',
  country           TEXT,
  founded_year      INTEGER,
  funding_type      TEXT CHECK (funding_type IN
                      ('private', 'public_company', 'state', 'nonprofit', 'individual', 'unknown')),
  wikidata_qid      TEXT,
  registrar         TEXT,
  domain_created_at TIMESTAMPTZ,
  whois_privacy     BOOLEAN,
  is_opaque         BOOLEAN NOT NULL DEFAULT FALSE,
  confidence        NUMERIC(3,2),
  evidence          JSONB NOT NULL DEFAULT '[]',
  researched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refresh_after     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days'
);

CREATE INDEX IF NOT EXISTS ownership_owner_group_key
  ON sources.ownership (owner_group_key)
  WHERE owner_group_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ownership_refresh_after
  ON sources.ownership (refresh_after);

COMMENT ON COLUMN sources.ownership.owner_group_key IS
  'Slug of the ultimate parent; the join key for corroboration diversity. Domains sharing this value are not independent sources.';
COMMENT ON COLUMN sources.ownership.is_opaque IS
  'No Wikidata entity, no imprint/about page, and privacy-shielded RDAP.';

-- migrate:down
DROP TABLE IF EXISTS sources.ownership;
```

**Step 2: Apply and verify**

Standard loop, then:
```bash
psql "$DATABASE_URL" -c "INSERT INTO sources.ownership (domain, funding_type) VALUES ('example.com','nope');"
```
Expected: FAILS with a check-constraint violation on `funding_type`. Then:
```bash
psql "$DATABASE_URL" -c "INSERT INTO sources.ownership (domain, funding_type) VALUES ('example.com','nonprofit') RETURNING refresh_after;"
```
Expected: succeeds, `refresh_after` roughly 90 days out. Clean up: `psql "$DATABASE_URL" -c "DELETE FROM sources.ownership;"`

**Step 3: Commit**

```bash
git add db/migrations/20260817000022_sources_ownership.sql
git commit -m "feat(db): add sources.ownership entity table"
```

### Task 3: Authors table and article link

**Files:**
- Create: `db/migrations/20260817000023_authors_records.sql`

**Step 1: Write the migration**

```sql
-- migrate:up
CREATE SCHEMA IF NOT EXISTS authors;

CREATE TABLE IF NOT EXISTS authors.records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain          TEXT NOT NULL,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  bio             TEXT,
  role            TEXT,
  beats           TEXT[],
  profile_urls    JSONB NOT NULL DEFAULT '{}',
  wikidata_qid    TEXT,
  is_person       BOOLEAN NOT NULL DEFAULT TRUE,
  article_count   INTEGER NOT NULL DEFAULT 0,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence      NUMERIC(3,2),
  evidence        JSONB NOT NULL DEFAULT '[]',
  researched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refresh_after   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',

  UNIQUE (domain, normalized_name)
);

CREATE INDEX IF NOT EXISTS authors_refresh_after ON authors.records (refresh_after);

ALTER TABLE articles.records
  ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES authors.records (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS records_author_id ON articles.records (author_id);

COMMENT ON COLUMN authors.records.is_person IS
  'FALSE for desk bylines ("Staff", "Editorial Board") and wire services (Reuters, AP, AFP).';
COMMENT ON COLUMN articles.records.author_id IS
  'Resolved author entity. articles.records.authored_by keeps the raw byline string.';

-- migrate:down
ALTER TABLE articles.records DROP COLUMN IF EXISTS author_id;
DROP TABLE IF EXISTS authors.records;
DROP SCHEMA IF EXISTS authors;
```

**Step 2: Apply and verify**

Standard loop, then confirm the unique constraint:
```bash
psql "$DATABASE_URL" -c "INSERT INTO authors.records (domain, name, normalized_name) VALUES ('bbc.co.uk','Jane Doe','jane doe'), ('bbc.co.uk','JANE DOE','jane doe');"
```
Expected: FAILS with a duplicate key violation on `(domain, normalized_name)`.

**Step 3: Commit**

```bash
git add db/migrations/20260817000023_authors_records.sql
git commit -m "feat(db): add authors.records and articles.records.author_id"
```

### Task 4: Richer similar-article rows

**Files:**
- Create: `db/migrations/20260817000024_similar_articles_research.sql`

**Step 1: Write the migration**

```sql
-- migrate:up
ALTER TABLE articles.similar_articles
  ADD COLUMN IF NOT EXISTS owner_group_key TEXT,
  ADD COLUMN IF NOT EXISTS is_independent  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS stance          TEXT,
  ADD COLUMN IF NOT EXISTS excerpt         TEXT;

ALTER TABLE articles.similar_articles
  ADD CONSTRAINT similar_articles_stance_check
  CHECK (stance IS NULL OR stance IN ('supports', 'contradicts', 'unclear'));

COMMENT ON COLUMN articles.similar_articles.is_independent IS
  'FALSE when this outlet shares an owner_group_key with the original article''s publication or with an earlier match.';

-- migrate:down
ALTER TABLE articles.similar_articles
  DROP CONSTRAINT IF EXISTS similar_articles_stance_check,
  DROP COLUMN IF EXISTS owner_group_key,
  DROP COLUMN IF EXISTS is_independent,
  DROP COLUMN IF EXISTS stance,
  DROP COLUMN IF EXISTS excerpt;
```

**Step 2: Apply and verify**

Standard loop, then `psql "$DATABASE_URL" -c "\d articles.similar_articles"` — expect the four new columns and the stance check.

**Step 3: Commit**

```bash
git add db/migrations/20260817000024_similar_articles_research.sql
git commit -m "feat(db): add ownership, stance and excerpt to similar_articles"
```

### Task 5: Citations, fetch cache, research runs, queue changes

**Files:**
- Create: `db/migrations/20260817000025_research_support_tables.sql`

**Step 1: Write the migration**

```sql
-- migrate:up
CREATE TABLE IF NOT EXISTS articles.citations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  UUID NOT NULL REFERENCES articles.records (id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  domain      TEXT NOT NULL,
  anchor_text TEXT,
  link_type   TEXT NOT NULL CHECK (link_type IN
                ('primary_source', 'outlet', 'social', 'self', 'other')),
  is_external BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (article_id, url)
);

CREATE INDEX IF NOT EXISTS citations_article ON articles.citations (article_id);

CREATE SCHEMA IF NOT EXISTS research;

CREATE TABLE IF NOT EXISTS research.fetch_cache (
  url          TEXT PRIMARY KEY,
  status_code  INTEGER,
  body         TEXT,
  content_type TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS fetch_cache_expires_at ON research.fetch_cache (expires_at);

CREATE TABLE IF NOT EXISTS articles.research_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id   UUID NOT NULL REFERENCES articles.records (id) ON DELETE CASCADE,
  job_id       UUID,
  model        TEXT,
  status       TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  duration_ms  INTEGER,
  node_timings JSONB NOT NULL DEFAULT '{}',
  node_errors  JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS research_runs_article ON articles.research_runs (article_id, created_at DESC);

-- Research jobs run for minutes and must not collide with the global url_hash
-- unique index, so they dedupe on article_id instead.
ALTER TABLE worker.jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_research_article_unique
  ON worker.jobs ((payload->>'article_id'))
  WHERE type = 'research_article' AND status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS jobs_type_status_scheduled
  ON worker.jobs (type, status, scheduled_at);

-- migrate:down
DROP INDEX IF EXISTS worker.jobs_type_status_scheduled;
DROP INDEX IF EXISTS worker.jobs_research_article_unique;
ALTER TABLE worker.jobs DROP COLUMN IF EXISTS heartbeat_at;
DROP TABLE IF EXISTS articles.research_runs;
DROP TABLE IF EXISTS research.fetch_cache;
DROP SCHEMA IF EXISTS research;
DROP TABLE IF EXISTS articles.citations;
```

**Step 2: Apply and verify the partial unique index behaves**

Standard loop, then:
```bash
psql "$DATABASE_URL" <<'SQL'
INSERT INTO worker.jobs (type, payload) VALUES ('research_article', '{"article_id":"a1"}');
INSERT INTO worker.jobs (type, payload) VALUES ('research_article', '{"article_id":"a1"}');
SQL
```
Expected: the second insert FAILS with a duplicate key violation. Then prove a completed job frees the slot:
```bash
psql "$DATABASE_URL" -c "UPDATE worker.jobs SET status='completed' WHERE type='research_article';"
psql "$DATABASE_URL" -c "INSERT INTO worker.jobs (type, payload) VALUES ('research_article', '{\"article_id\":\"a1\"}');"
psql "$DATABASE_URL" -c "DELETE FROM worker.jobs WHERE type='research_article';"
```
Expected: succeeds.

**Step 3: Commit**

```bash
git add db/migrations/20260817000025_research_support_tables.sql
git commit -m "feat(db): add citations, fetch cache, research runs and research job queue support"
```

---

# Phase 1 — Slim the TypeScript worker

All paths below are relative to `/home/brandee/repos/truth-accord-background-worker`.
Run tests with `npm test`, types with `npm run typecheck`, lint with `npm run lint`.

Do **not** delete `OllamaService` or the heuristic scorers yet — that happens in Phase 5, after the parity run. Until then the old pipeline stays runnable behind an env flag.

### Task 6: Extract outbound links during scraping

**Files:**
- Modify: `src/services/scraper/scraper.interfaces.ts`
- Modify: `src/services/scraper/static-scraper.service.ts:20-70`
- Create: `src/services/scraper/static-scraper.test.ts`

**Step 1: Write the failing test**

`src/services/scraper/static-scraper.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StaticScraperService } from './static-scraper.service.ts'

const svc = new StaticScraperService()

const HTML = `
<html><body><article>
  <p>Body text goes here with enough words to count as content.</p>
  <a href="https://www.gov.uk/report">the official report</a>
  <a href="/local/story">related story</a>
  <a href="https://twitter.com/someone/status/1">a tweet</a>
  <a href="#anchor">skip me</a>
  <a href="mailto:x@y.com">skip me too</a>
</article></body></html>`

describe('extractArticleData links', () => {
  it('returns absolute URLs resolved against the page URL', () => {
    const { links } = svc.extractArticleData(HTML, 'https://news.example.com/a/b')
    const urls = links.map((l) => l.url)
    assert.ok(urls.includes('https://www.gov.uk/report'))
    assert.ok(urls.includes('https://news.example.com/local/story'))
  })

  it('captures anchor text', () => {
    const { links } = svc.extractArticleData(HTML, 'https://news.example.com/a/b')
    const gov = links.find((l) => l.url === 'https://www.gov.uk/report')
    assert.equal(gov?.anchor, 'the official report')
  })

  it('skips fragment and non-http links', () => {
    const { links } = svc.extractArticleData(HTML, 'https://news.example.com/a/b')
    const urls = links.map((l) => l.url)
    assert.ok(!urls.some((u) => u.startsWith('mailto:')))
    assert.ok(!urls.some((u) => u.includes('#anchor')))
  })

  it('deduplicates repeated links', () => {
    const dup = '<article><a href="https://a.com/x">one</a><a href="https://a.com/x">two</a></article>'
    const { links } = svc.extractArticleData(dup, 'https://news.example.com/')
    assert.equal(links.filter((l) => l.url === 'https://a.com/x').length, 1)
  })

  it('returns an empty array when there are no links', () => {
    const { links } = svc.extractArticleData('<article><p>no links</p></article>', 'https://x.com/')
    assert.deepEqual(links, [])
  })
})
```

**Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern="extractArticleData links"`
Expected: FAIL — `extractArticleData` takes one argument and returns no `links`.

**Step 3: Implement**

In `scraper.interfaces.ts` add:

```typescript
export interface OutboundLink {
  url: string
  anchor: string | null
  rel: string | null
}
```

and add `links: OutboundLink[]` to both `ExtractedArticleData` and `ScrapedArticle`.

In `static-scraper.service.ts`, change the signature to `extractArticleData(html: string, pageUrl: string): ExtractedArticleData` and collect links from `contentEl` **before** the `.remove()` call that strips nav/footer:

```typescript
const links: OutboundLink[] = []
const seen = new Set<string>()
contentEl.find('a[href]').each((_, el) => {
  const href = $(el).attr('href')?.trim()
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) return
  let absolute: string
  try {
    absolute = new URL(href, pageUrl).toString()
  } catch {
    return
  }
  if (!absolute.startsWith('http')) return
  if (seen.has(absolute)) return
  seen.add(absolute)
  links.push({
    url: absolute,
    anchor: $(el).text().replace(/\s+/g, ' ').trim() || null,
    rel: $(el).attr('rel') ?? null,
  })
})
```

Return `links` in the result object. Update the two call sites in `src/services/scraper/scraper.service.ts` to pass the page URL, and make `dynamic-scraper.service.ts` supply `links: []` if it builds `ExtractedArticleData` itself.

**Step 4: Verify**

```bash
npm test -- --test-name-pattern="extractArticleData links"
npm run typecheck
```
Expected: PASS, no type errors.

**Step 5: Commit**

```bash
git add src/services/scraper/
git commit -m "feat(scraper): extract outbound links with anchor text"
```

### Task 7: Article content repository

**Files:**
- Create: `src/repositories/article-content.repository.ts`
- Modify: `src/types.ts`

**Step 1: Write the code** (a thin SQL wrapper; covered by the integration test in Task 9)

```typescript
import { query } from '../db/client.ts'
import type { OutboundLink } from '../services/scraper/scraper.interfaces.ts'

export class ArticleContentRepository {
  async upsert(articleId: string, text: string, links: OutboundLink[]): Promise<void> {
    await query(
      `INSERT INTO articles.content (article_id, text, links, char_count, fetched_at)
       VALUES ($1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (article_id) DO UPDATE SET
         text       = EXCLUDED.text,
         links      = EXCLUDED.links,
         char_count = EXCLUDED.char_count,
         fetched_at = NOW()`,
      [articleId, text, JSON.stringify(links), text.length],
    )
  }
}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

**Step 3: Commit**

```bash
git add src/repositories/article-content.repository.ts src/types.ts
git commit -m "feat(repo): add article content repository"
```

### Task 8: Enqueue research jobs

**Files:**
- Modify: `src/repositories/worker-jobs.repository.ts:32-56`
- Create: `src/repositories/worker-jobs.research.test.ts`

**Step 1: Write the failing test**

The method builds SQL; test it by injecting a fake query function. Refactor `WorkerJobsRepository` to take an optional query function in its constructor, defaulting to the imported `query`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WorkerJobsRepository } from './worker-jobs.repository.ts'

describe('createResearchJob', () => {
  it('inserts a research_article job with the article id in the payload', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const repo = new WorkerJobsRepository(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return [{ id: 'job-1' }]
    })

    const created = await repo.createResearchJob('article-1', 'https://x.com/a', 'climate')

    assert.equal(created, true)
    assert.match(calls[0]!.sql, /research_article/)
    const payload = JSON.parse(String(calls[0]!.params[0]))
    assert.equal(payload.article_id, 'article-1')
    assert.equal(payload.url, 'https://x.com/a')
    assert.equal(payload.search_term, 'climate')
  })

  it('never sets url_hash, which is globally unique and owned by the scrape job', async () => {
    const calls: string[] = []
    const repo = new WorkerJobsRepository(async (sql: string) => { calls.push(sql); return [{ id: 'j' }] })
    await repo.createResearchJob('article-1', 'https://x.com/a', null)
    assert.ok(!calls[0]!.includes('url_hash'), 'research jobs must leave url_hash NULL')
  })

  it('returns false when the partial unique index rejects a duplicate', async () => {
    const repo = new WorkerJobsRepository(async () => [])
    assert.equal(await repo.createResearchJob('article-1', 'https://x.com/a', null), false)
  })
})
```

**Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern="createResearchJob"`
Expected: FAIL — constructor takes no arguments, `createResearchJob` is not a function.

**Step 3: Implement**

Add to the constructor: `constructor(private readonly q: typeof query = query) {}` and use `this.q(...)` in the new method only (leave existing methods alone to keep the diff small):

```typescript
async createResearchJob(articleId: string, url: string, searchTerm: string | null): Promise<boolean> {
  const payload = JSON.stringify({ article_id: articleId, url, search_term: searchTerm })
  const rows = await this.q<{ id: string }>(
    `INSERT INTO worker.jobs (type, payload)
     VALUES ('research_article', $1)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [payload],
  )
  return rows.length > 0
}
```

**Step 4: Verify**

Run: `npm test -- --test-name-pattern="createResearchJob" && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/repositories/worker-jobs.repository.ts src/repositories/worker-jobs.research.test.ts
git commit -m "feat(queue): enqueue research_article jobs"
```

### Task 9: Rewire ScrapeWorker to stop at the handoff

**Files:**
- Modify: `src/workers/scrape-worker.ts:70-264`
- Modify: `src/index.ts:30-50`
- Create: `src/workers/scrape-worker.test.ts`

The worker's steps 4, 6 and 7 (classification, similar articles, truthfulness scoring) are removed. New flow: scrape → paywall/Wayback → `sources.domains` → upsert article `status='pending'`, `category=null` → write `articles.content` → `createResearchJob` → mark job completed.

**Step 1: Write the failing test**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ScrapeWorker } from './scrape-worker.ts'
import type { ScrapeJob } from '../types.ts'

function makeWorker(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const scraped = {
    url: 'https://news.example.com/a', title: 'A title', content: 'body '.repeat(200),
    author: 'Jane Doe', publishedAt: null, metaDescription: 'A description',
    wordCount: 200, isArchived: false, snapshotTimestamp: null, paywallDetected: false,
    links: [{ url: 'https://gov.uk/x', anchor: 'report', rel: null }],
  }
  const deps = {
    scraper: { scrape: async () => scraped },
    wayback: { getLatestSnapshot: async () => null },
    articles: { upsert: async (input: { status?: string }) => { calls.push(`upsert:${input.status}`); return { id: 'article-1', url: scraped.url } } },
    workerJobsRepo: {
      createResearchJob: async (id: string) => { calls.push(`research:${id}`); return true },
      updateStatus: async (_id: string, s: string) => { calls.push(`job:${s}`) },
      failWithRetry: async () => { calls.push('job:retry') },
    },
    articleContentRepo: { upsert: async () => { calls.push('content') } },
    sourcesRepo: { ensureExists: async () => {}, markPaywall: async () => {}, markUnarchivable: async () => {} },
    ...overrides,
  }
  // constructor order matches src/workers/scrape-worker.ts
  const worker = new ScrapeWorker(
    deps.scraper as never, deps.wayback as never, deps.articles as never,
    deps.workerJobsRepo as never, deps.articleContentRepo as never, deps.sourcesRepo as never,
  )
  return { worker, calls }
}

const job: ScrapeJob = {
  id: 'job-1', url: 'https://news.example.com/a', search_term: 'climate',
  status: 'running', attempts: 0, max_attempts: 3, last_error: null,
}

describe('ScrapeWorker.processJob', () => {
  it('inserts the article as pending, stores content, then enqueues research', async () => {
    const { worker, calls } = makeWorker()
    await (worker as unknown as { processJob(j: ScrapeJob): Promise<void> }).processJob(job)
    assert.deepEqual(calls, ['upsert:pending', 'content', 'research:article-1', 'job:completed'])
  })

  it('makes no LLM or similar-article calls', async () => {
    const { worker } = makeWorker()
    // The constructor no longer accepts ollama/truthfulness/referenceSitesCrawl deps.
    assert.equal(ScrapeWorker.length, 6)
  })

  it('fails the job with retry when scraping throws', async () => {
    const { worker, calls } = makeWorker({ scraper: { scrape: async () => { throw new Error('boom') } } })
    await (worker as unknown as { processJob(j: ScrapeJob): Promise<void> }).processJob(job)
    assert.ok(calls.includes('job:retry'))
  })
})
```

**Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern="ScrapeWorker.processJob"`
Expected: FAIL — the constructor still takes ten dependencies.

**Step 3: Implement**

Rewrite `processJob` to the six-step flow (keep the `[n/4]` style logging, the timing, and the existing catch block verbatim). Delete the `minSimilarityScore` field and the `SIMILAR_ARTICLE_MIN_SCORE` parsing. The article upsert becomes:

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
  status: 'pending',
  category: null,
})
await this.articleContentRepo.upsert(article.id, scraped.content ?? '', scraped.links)
const queued = await this.workerJobsRepo.createResearchJob(article.id, scraped.url, job.search_term)
if (!queued) console.log(`[Job ${id}]       research job already queued for ${article.id}`)
await this.workerJobsRepo.updateStatus(id, 'completed')
```

Note the status is always `pending` now — the "incomplete metadata → pending" branch disappears because research decides the final status.

Update `src/index.ts`: construct `ArticleContentRepository`, pass the six deps, and stop constructing `OllamaService`, `TruthfulnessService` and `ReferenceSitesCrawlService` for the scrape worker (`ReferenceSitesCrawlService` is still used by nothing in TS after this — leave the file in place until Phase 5).

**Step 4: Verify**

```bash
npm test
npm run typecheck
npm run lint
```
Expected: all pass. `ollama.service.test.ts` and `reference-sites-crawl.test.ts` still pass — those files are untouched.

**Step 5: Commit**

```bash
git add src/workers/scrape-worker.ts src/workers/scrape-worker.test.ts src/index.ts
git commit -m "refactor(worker): hand articles off to the research queue instead of scoring inline"
```

---

# Phase 2 — Python service skeleton

New repo at `/home/brandee/repos/truth-accord-research`. Every task below runs from that directory.

### Task 10: Scaffold the repo

**Files:**
- Create: `pyproject.toml`, `.env.example`, `.gitignore`, `README.md`, `src/research/__init__.py`, `tests/__init__.py`

**Step 1: Create the project**

```bash
mkdir -p /home/brandee/repos/truth-accord-research
cd /home/brandee/repos/truth-accord-research
git init
mkdir -p src/research/{agents,tools,chains,db} tests/fixtures
touch src/research/__init__.py tests/__init__.py
```

`pyproject.toml`:

```toml
[project]
name = "truth-accord-research"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "langchain-core>=0.3",
  "langchain-ollama>=0.2",
  "langgraph>=0.2",
  "pydantic>=2.9",
  "psycopg[binary,pool]>=3.2",
  "httpx>=0.27",
  "beautifulsoup4>=4.12",
  "lxml>=5.3",
  "trafilatura>=2.0",
  "fastapi>=0.115",
  "uvicorn>=0.32",
  "python-dotenv>=1.0",
]

[dependency-groups]
dev = ["pytest>=8.3", "pytest-asyncio>=0.24", "respx>=0.21", "ruff>=0.8"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/research"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
pythonpath = ["src"]

[tool.ruff]
line-length = 110
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "ASYNC"]
```

`.gitignore`: `.venv/`, `__pycache__/`, `.env`, `.pytest_cache/`, `*.egg-info/`

`.env.example`:

```
DATABASE_URL=postgres://user:password@localhost:5432/truth_accord

OLLAMA_BASE_URL=http://10.13.37.54:30068
OLLAMA_MODEL=gemma4
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_TIMEOUT_S=60

RESEARCH_POLL_INTERVAL_MS=5000
RESEARCH_CONCURRENCY=2
RESEARCH_MAX_ATTEMPTS=3
RESEARCH_STUCK_MINUTES=30

CORROBORATION_MAX_CANDIDATES=200   # RSS items embedded per job
CORROBORATION_PREFILTER_TOPK=20    # candidates the LLM scores
CORROBORATION_FULLTEXT_TOPK=8      # candidates whose full text is fetched
SIMILAR_ARTICLE_MIN_SCORE=0.25

OWNERSHIP_TTL_DAYS=90
AUTHOR_TTL_DAYS=30
FETCH_CACHE_TTL_HOURS=168
FETCH_TIMEOUT_S=15
USER_AGENT=Mozilla/5.0 (compatible; TruthAccordBot/1.0; +https://truthaccord.example/bot)
HEALTH_PORT=8081
```

**Step 2: Install and verify the toolchain**

```bash
uv sync
uv run ruff check .
uv run pytest
```
Expected: ruff clean; pytest exits with "no tests ran".

**Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold python research service"
```

### Task 11: Settings and database pool

**Files:**
- Create: `src/research/settings.py`, `src/research/db/pool.py`
- Create: `tests/test_settings.py`

**Step 1: Write the failing test**

```python
import os
from research.settings import Settings


def test_reads_defaults(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x/y")
    monkeypatch.delenv("OWNERSHIP_TTL_DAYS", raising=False)
    s = Settings.from_env()
    assert s.ownership_ttl_days == 90
    assert s.research_concurrency == 2


def test_invalid_numeric_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x/y")
    monkeypatch.setenv("RESEARCH_CONCURRENCY", "not-a-number")
    assert Settings.from_env().research_concurrency == 2


def test_missing_database_url_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    try:
        Settings.from_env()
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "DATABASE_URL" in str(e)
```

**Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_settings.py -v`
Expected: FAIL — `ModuleNotFoundError: research.settings`.

**Step 3: Implement**

`settings.py`: a frozen dataclass with one field per `.env.example` entry and a `from_env()` classmethod. Numeric parsing goes through a helper that warns and returns the default on a bad value (mirrors `positiveIntEnv` in the TS service). `DATABASE_URL` missing raises `RuntimeError`.

`db/pool.py`: module-level `AsyncConnectionPool` from `psycopg_pool`, plus `fetch_all(sql, params) -> list[dict]`, `fetch_one(sql, params) -> dict | None`, `execute(sql, params) -> int`, and an async `transaction()` context manager. Use `psycopg.rows.dict_row`.

**Step 4: Verify**

Run: `uv run pytest tests/test_settings.py -v`
Expected: 3 passed.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: settings and async postgres pool"
```

### Task 12: Job queue claim, heartbeat, retry

**Files:**
- Create: `src/research/db/jobs.py`
- Create: `tests/test_jobs.py`, `tests/conftest.py`

These tests hit a real Postgres, because `FOR UPDATE SKIP LOCKED` and the partial unique index cannot be tested against a mock. `conftest.py` skips them when `TEST_DATABASE_URL` is unset.

**Step 1: Write the failing test**

`tests/conftest.py`:

```python
import os
import pytest

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
requires_db = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL not set")
```

`tests/test_jobs.py`:

```python
import pytest
from tests.conftest import requires_db, TEST_DATABASE_URL
from research.db import jobs, pool


@pytest.fixture(autouse=True)
async def clean_queue():
    await pool.init(TEST_DATABASE_URL)
    await pool.execute("DELETE FROM worker.jobs WHERE type = 'research_article'")
    yield
    await pool.execute("DELETE FROM worker.jobs WHERE type = 'research_article'")


@requires_db
async def test_claims_pending_research_jobs_only():
    await pool.execute(
        "INSERT INTO worker.jobs (type, payload) VALUES ('research_article', %s), ('scrape_url', %s)",
        ['{"article_id": "11111111-1111-1111-1111-111111111111"}', '{"url": "https://x"}'],
    )
    claimed = await jobs.claim_pending(limit=5)
    assert len(claimed) == 1
    assert claimed[0].article_id == "11111111-1111-1111-1111-111111111111"


@requires_db
async def test_claimed_job_is_marked_running_with_heartbeat():
    await pool.execute("INSERT INTO worker.jobs (type, payload) VALUES ('research_article', %s)",
                       ['{"article_id": "22222222-2222-2222-2222-222222222222"}'])
    (job,) = await jobs.claim_pending(limit=5)
    row = await pool.fetch_one("SELECT status, heartbeat_at FROM worker.jobs WHERE id = %s", [job.id])
    assert row["status"] == "running"
    assert row["heartbeat_at"] is not None


@requires_db
async def test_second_claim_returns_nothing():
    await pool.execute("INSERT INTO worker.jobs (type, payload) VALUES ('research_article', %s)",
                       ['{"article_id": "33333333-3333-3333-3333-333333333333"}'])
    await jobs.claim_pending(limit=5)
    assert await jobs.claim_pending(limit=5) == []


@requires_db
async def test_fail_with_retry_backs_off_then_dies():
    await pool.execute("INSERT INTO worker.jobs (type, payload, max_attempts) VALUES ('research_article', %s, 2)",
                       ['{"article_id": "44444444-4444-4444-4444-444444444444"}'])
    (job,) = await jobs.claim_pending(limit=5)

    await jobs.fail_with_retry(job.id, "first failure")
    row = await pool.fetch_one("SELECT status, attempts, last_error FROM worker.jobs WHERE id = %s", [job.id])
    assert row["status"] == "pending"
    assert row["attempts"] == 1
    assert row["last_error"] == "first failure"

    await jobs.fail_with_retry(job.id, "second failure")
    row = await pool.fetch_one("SELECT status, attempts FROM worker.jobs WHERE id = %s", [job.id])
    assert row["status"] == "dead"
    assert row["attempts"] == 2


@requires_db
async def test_reset_stuck_running_requeues_old_jobs():
    await pool.execute(
        """INSERT INTO worker.jobs (type, payload, status, started_at, heartbeat_at)
           VALUES ('research_article', %s, 'running', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')""",
        ['{"article_id": "55555555-5555-5555-5555-555555555555"}'],
    )
    assert await jobs.reset_stuck_running(minutes=30) == 1


@requires_db
async def test_heartbeat_keeps_a_long_job_from_being_reset():
    await pool.execute(
        """INSERT INTO worker.jobs (type, payload, status, started_at, heartbeat_at)
           VALUES ('research_article', %s, 'running', NOW() - INTERVAL '2 hours', NOW())""",
        ['{"article_id": "66666666-6666-6666-6666-666666666666"}'],
    )
    assert await jobs.reset_stuck_running(minutes=30) == 0
```

**Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL uv run pytest tests/test_jobs.py -v`
Expected: FAIL — `research.db.jobs` does not exist.

**Step 3: Implement**

`jobs.py` holds a `ResearchJob` dataclass (`id`, `article_id`, `url`, `search_term`, `attempts`, `max_attempts`) and four functions. Mirror the TS backoff exactly — `BACKOFF_SECONDS = (30, 120, 600)`, index `min(attempts - 1, 2)`.

```python
async def claim_pending(limit: int) -> list[ResearchJob]:
    rows = await pool.fetch_all(
        """UPDATE worker.jobs
           SET status = 'running', started_at = NOW(), heartbeat_at = NOW()
           WHERE id IN (
             SELECT id FROM worker.jobs
             WHERE type = 'research_article' AND status = 'pending' AND scheduled_at <= NOW()
             ORDER BY scheduled_at ASC
             LIMIT %s
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, payload, attempts, max_attempts""",
        [limit],
    )
    return [ResearchJob.from_row(r) for r in rows]
```

`heartbeat(job_id)` sets `heartbeat_at = NOW()`. `reset_stuck_running(minutes)` requeues `running` research jobs whose `heartbeat_at` is older than the cutoff (falling back to `started_at` when null) and returns the count. `complete(job_id)` sets `status='completed', completed_at=NOW()`.

**Step 4: Verify**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL uv run pytest tests/test_jobs.py -v`
Expected: 6 passed.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: research job queue claim, heartbeat and retry"
```

### Task 13: Worker loop and health endpoint

**Files:**
- Create: `src/research/worker.py`, `src/research/health.py`, `src/research/__main__.py`
- Create: `tests/test_worker.py`

**Step 1: Write the failing test**

```python
import asyncio
from research.worker import ResearchWorker


class FakeQueue:
    def __init__(self, batches): self.batches, self.completed, self.failed = list(batches), [], []
    async def claim_pending(self, limit): return self.batches.pop(0) if self.batches else []
    async def complete(self, job_id): self.completed.append(job_id)
    async def fail_with_retry(self, job_id, error): self.failed.append((job_id, error))
    async def heartbeat(self, job_id): pass
    async def reset_stuck_running(self, minutes): return 0


async def test_runs_each_claimed_job_and_completes_it():
    queue = FakeQueue([[FakeJob("j1"), FakeJob("j2")]])
    ran = []
    worker = ResearchWorker(queue, run_graph=lambda job: ran.append(job.id), concurrency=2)
    await worker.poll_once()
    assert ran == ["j1", "j2"]
    assert queue.completed == ["j1", "j2"]


async def test_a_failing_job_is_retried_and_does_not_stop_the_batch():
    queue = FakeQueue([[FakeJob("bad"), FakeJob("good")]])
    async def run(job):
        if job.id == "bad":
            raise RuntimeError("graph exploded")
    worker = ResearchWorker(queue, run_graph=run, concurrency=2)
    await worker.poll_once()
    assert queue.completed == ["good"]
    assert queue.failed == [("bad", "graph exploded")]


async def test_overlapping_polls_are_skipped_while_a_batch_is_in_flight():
    queue = FakeQueue([[FakeJob("slow")], [FakeJob("next")]])
    worker = ResearchWorker(queue, run_graph=slow_run, concurrency=1)
    await asyncio.gather(worker.poll_once(), worker.poll_once())
    assert queue.completed == ["slow"]
```

(Define `FakeJob` as a small dataclass with `id`, `article_id`, `attempts`, `max_attempts`, and `slow_run` as a coroutine that sleeps 0.05s.)

**Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_worker.py -v`
Expected: FAIL — `research.worker` does not exist.

**Step 3: Implement**

`ResearchWorker` takes the queue module (injectable for tests), a `run_graph` callable and a concurrency limit. `poll_once()` guards re-entry with an `is_running` flag like the TS worker, resets stuck jobs, claims up to `concurrency` jobs, and runs them under an `asyncio.Semaphore`. Each job runs with a background heartbeat task that ticks every 60 s and is cancelled in a `finally`. `start()` loops with `asyncio.sleep(poll_interval)`; SIGTERM/SIGINT set a stop event and drain in-flight jobs.

`health.py`: a FastAPI app with `GET /health` returning `{"status": "ok", "queue": {...}}` from a one-line stats query. `__main__.py` starts uvicorn and the worker loop with `asyncio.gather`.

**Step 4: Verify**

```bash
uv run pytest -v
uv run ruff check .
```
Expected: all pass.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: research worker loop and health endpoint"
```

---

# Phase 3 — Port the existing LLM tasks to LangChain

Straight port: same prompts, same meanings, structured output instead of regex JSON scraping. Behaviour changes come in Phase 4.

Every chain test uses `langchain_core.language_models.fake_chat_models.GenericFakeChatModel` or a small stub, so **no test in this phase requires Ollama**.

### Task 14: LLM factory

**Files:**
- Create: `src/research/llm.py`
- Create: `tests/test_llm.py`

**Step 1: Write the failing test**

```python
from research.llm import get_chat_model, get_embeddings


def test_chat_model_is_configured_from_settings(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x/y")
    monkeypatch.setenv("OLLAMA_MODEL", "gemma4")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.test:11434")
    model = get_chat_model()
    assert model.model == "gemma4"
    assert model.base_url == "http://ollama.test:11434"


def test_temperature_is_zero_for_deterministic_extraction(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://x/y")
    assert get_chat_model().temperature == 0
```

**Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_llm.py -v` → FAIL, module missing.

**Step 3: Implement**

```python
from functools import cache
from langchain_ollama import ChatOllama, OllamaEmbeddings
from research.settings import Settings


@cache
def get_chat_model() -> ChatOllama:
    s = Settings.from_env()
    return ChatOllama(model=s.ollama_model, base_url=s.ollama_base_url,
                      temperature=0, timeout=s.ollama_timeout_s)


@cache
def get_embeddings() -> OllamaEmbeddings:
    s = Settings.from_env()
    return OllamaEmbeddings(model=s.ollama_embed_model, base_url=s.ollama_base_url)
```

**Step 4: Verify** — `uv run pytest tests/test_llm.py -v` → 2 passed.

**Step 5: Commit** — `git commit -am "feat: ollama chat and embedding model factory"`

### Task 15: Classification chain (category, bias, language)

Port of `OllamaService.scoreContentAndClassify` (`src/services/ollama.service.ts:66-100` in the TS repo).

**Files:**
- Create: `src/research/chains/classify.py`
- Create: `tests/test_classify.py`

**Step 1: Write the failing test**

```python
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from research.chains.classify import ContentClassification, build_classify_chain

CATEGORIES = {"politics", "economics", "science", "health", "technology",
              "education", "law", "environment", "world", "society"}


async def test_returns_parsed_classification():
    llm = fake_structured(ContentClassification(category="politics", bias_score=30, language_score=45))
    result = await build_classify_chain(llm).ainvoke(
        {"title": "Senate passes bill", "summary": "The senate voted", "content": "body text"})
    assert result.category == "politics"
    assert result.bias_score == 30


async def test_rejects_a_category_outside_the_allowed_list():
    llm = fake_structured(ContentClassification(category="sports", bias_score=10, language_score=10))
    result = await build_classify_chain(llm).ainvoke({"title": "t", "summary": "s", "content": "c"})
    assert result.category is None


async def test_clamps_scores_to_0_100():
    llm = fake_structured(ContentClassification(category=None, bias_score=180, language_score=-20))
    result = await build_classify_chain(llm).ainvoke({"title": "t", "summary": "s", "content": "c"})
    assert result.bias_score == 100
    assert result.language_score == 0


async def test_returns_empty_classification_when_the_model_errors():
    result = await build_classify_chain(RaisingModel()).ainvoke({"title": "t", "summary": "s", "content": "c"})
    assert result.category is None and result.bias_score is None
```

**Step 2: Run it to verify it fails** — `uv run pytest tests/test_classify.py -v` → module missing.

**Step 3: Implement**

```python
class ContentClassification(BaseModel):
    category: str | None = Field(description=f"one of: {', '.join(CATEGORIES)}, or null if none fit")
    bias_score: int | None = Field(description="0 = balanced and unbiased, 100 = heavily one-sided")
    language_score: int | None = Field(description="0 = calm, 50 = neutral reporting, 100 = inflammatory")

    @field_validator("category")
    @classmethod
    def _known_category(cls, v):
        if v is None: return None
        v = v.strip().lower()
        return v if v in CATEGORIES else None

    @field_validator("bias_score", "language_score")
    @classmethod
    def _clamp(cls, v):
        return None if v is None else max(0, min(100, int(v)))
```

The chain is `prompt | llm.with_structured_output(ContentClassification)` wrapped in `.with_fallbacks([RunnableLambda(lambda _: ContentClassification(category=None, bias_score=None, language_score=None))])`. Keep the prompt wording from the TS version, including truncating content to 500 characters.

**Step 4: Verify** — `uv run pytest tests/test_classify.py -v` → 4 passed.

**Step 5: Commit** — `git commit -am "feat: langchain classification chain"`

### Task 16: Reference feed loading

Port of `ReferenceSitesCrawlService.getAllFeedItems` — Python now owns candidate collection.

**Files:**
- Create: `src/research/reference_feeds.py`
- Create: `tests/test_reference_feeds.py`, `tests/fixtures/rss_sample.xml`, `tests/fixtures/atom_sample.xml`

**Step 1: Write the failing test**

Cover: RSS 2.0 parsing, Atom parsing, deduplication by URL across feeds, skipping non-http links, a failing feed not aborting the batch (use `respx` to mock one feed 500 and another 200), and the sites list coming from `sources.records WHERE trust_score IS NOT NULL AND rss_url IS NOT NULL AND is_active`.

**Step 2: Run it to verify it fails.**

**Step 3: Implement** — `httpx.AsyncClient` with `SEARCH_FEED_TIMEOUT` and the configured user agent, `feedparser`-free parsing via `lxml.etree` (already a dependency); return `list[FeedItem]` with `url`, `title`, `description`, `source_domain`. Fetch feeds with `asyncio.gather(..., return_exceptions=True)` and log failures without raising, matching the TS behaviour.

**Step 4: Verify** — all tests pass.

**Step 5: Commit** — `git commit -am "feat: reference RSS feed loading"`

### Task 17: Embedding pre-filter

Port of `OllamaService.findSimilarArticles`'s ranking half (`cosineSimilarity` + top-K selection).

**Files:**
- Create: `src/research/chains/prefilter.py`
- Create: `tests/test_prefilter.py`

**Step 1: Write the failing test**

```python
async def test_ranks_candidates_by_cosine_similarity():
    embeddings = StubEmbeddings({"original": [1.0, 0.0], "close": [0.9, 0.1], "far": [0.0, 1.0]})
    ranked = await rank_candidates("original", [item("close"), item("far")], embeddings, top_k=2)
    assert [r.candidate.title for r in ranked] == ["close", "far"]


async def test_returns_none_when_embeddings_fail():
    assert await rank_candidates("original", [item("a")], RaisingEmbeddings(), top_k=2) is None


async def test_zero_vectors_score_zero_rather_than_nan():
    embeddings = StubEmbeddings({"original": [0.0, 0.0], "a": [1.0, 1.0]})
    ranked = await rank_candidates("original", [item("a")], embeddings, top_k=1)
    assert ranked[0].cosine == 0.0


async def test_truncates_to_max_candidates():
    ranked = await rank_candidates("o", [item(str(i)) for i in range(500)], StubEmbeddings.uniform(), top_k=5)
    assert len(ranked) == 5
```

**Step 2–4:** implement `cosine_similarity` and `rank_candidates` mirroring the TS guards (NaN → 0, cap at `CORROBORATION_MAX_CANDIDATES`), verify tests pass.

**Step 5: Commit** — `git commit -am "feat: embedding candidate pre-filter"`

### Task 18: Same-story chain with full text and stance

This is the first real upgrade: the top `CORROBORATION_FULLTEXT_TOPK` candidates get their actual text fetched, and the model returns a stance as well as a score.

**Files:**
- Create: `src/research/chains/corroboration.py`
- Create: `tests/test_corroboration.py`

**Step 1: Write the failing test**

```python
async def test_scores_only_same_specific_story():
    llm = fake_structured(CorroborationResult(matches=[
        Match(index=1, similarity_score=90, stance="supports", excerpt="Officials confirmed the vote"),
        Match(index=2, similarity_score=10, stance="unclear", excerpt=""),
    ]))
    result = await score_candidates(original, candidates, llm=llm, min_score=0.25)
    assert [m.url for m in result] == [candidates[0].url]


async def test_out_of_range_indexes_are_dropped():
    llm = fake_structured(CorroborationResult(matches=[Match(index=99, similarity_score=90, stance="supports")]))
    assert await score_candidates(original, candidates, llm=llm, min_score=0.25) == []


async def test_contradicting_matches_are_kept_with_their_stance():
    llm = fake_structured(CorroborationResult(matches=[
        Match(index=1, similarity_score=85, stance="contradicts", excerpt="The council denied it")]))
    (match,) = await score_candidates(original, candidates, llm=llm, min_score=0.25)
    assert match.stance == "contradicts"


async def test_full_text_is_used_when_available_and_description_otherwise():
    # candidate 1 has fetched text, candidate 2 does not
    prompt = build_candidate_block([with_text, without_text])
    assert "fetched body paragraph" in prompt
    assert without_text.description in prompt


async def test_returns_none_when_the_model_fails_so_the_caller_can_degrade():
    assert await score_candidates(original, candidates, llm=RaisingModel(), min_score=0.25) is None
```

**Step 2: Run it to verify it fails.**

**Step 3: Implement**

`score_candidates` fetches full text for the top-K candidates via the `fetch_page` tool from Task 19 (inject it, default to the real one), truncates each to ~1200 characters, builds the numbered candidate block, and calls `llm.with_structured_output(CorroborationResult)`. Keep the TS prompt's strictness paragraph ("Same story means the same specific event…") verbatim — it is doing real work. `stance` is a `Literal["supports", "contradicts", "unclear"]`. Returning `None` on model failure lets the caller record a node error and continue with no matches.

**Step 4: Verify** — all tests pass.

**Step 5: Commit** — `git commit -am "feat: corroboration chain with full text and stance"`

---

# Phase 4 — New research: tools, agents, scoring

### Task 19: Cached page fetcher

**Files:**
- Create: `src/research/tools/fetch.py`
- Create: `tests/test_fetch.py`

**Step 1: Write the failing test** (with `respx`)

Cover: a successful fetch is written to `research.fetch_cache`; a second call within the TTL does not hit the network; an expired row is refetched; a 404 is cached as a negative result so a missing `/imprint` is not retried on every job; `robots.txt` disallow returns `None` without fetching; a timeout returns `None` and is not cached; HTML is reduced to readable text with `trafilatura` and falls back to BeautifulSoup `get_text()` when trafilatura returns nothing.

**Step 2: Run it to verify it fails.**

**Step 3: Implement** — `async def fetch_page(url: str, *, ttl_hours: int | None = None) -> FetchedPage | None`. One shared `httpx.AsyncClient` with `follow_redirects=True`, the configured user agent, and a per-host `asyncio.Semaphore(2)` for politeness. Cache key is the URL after stripping fragments and common tracking params.

**Step 4: Verify.** **Step 5: Commit** — `git commit -am "feat: cached, robots-respecting page fetcher"`

### Task 20: Wikidata lookup tool

**Files:**
- Create: `src/research/tools/wikidata.py`
- Create: `tests/test_wikidata.py`, `tests/fixtures/wikidata_bbc.json`, `tests/fixtures/wikidata_search.json`

**Step 1: Write the failing test**

Save a real response first so the fixture is honest:

```bash
curl -s 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=BBC%20News&language=en&format=json&limit=5' \
  > tests/fixtures/wikidata_search.json
curl -s 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q9531&props=claims|labels|sitelinks&format=json' \
  > tests/fixtures/wikidata_bbc.json
```

Tests: resolves a publication name to a QID; extracts `P127` (owned by), `P749` (parent organization), `P17` (country), `P571` (inception year), `P112` (founder); follows the parent chain up to 4 hops and stops on a cycle; returns `None` for an unknown entity; resolves referenced QIDs to human-readable labels; a network error returns `None` rather than raising.

**Step 2–4:** implement `lookup_organization(name) -> WikidataOrg | None` and `lookup_person(name, context) -> WikidataPerson | None`, verify against the fixtures with `respx`.

**Step 5: Commit** — `git commit -am "feat: wikidata organization and person lookup"`

### Task 21: Wikipedia summary tool

**Files:** `src/research/tools/wikipedia.py`, `tests/test_wikipedia.py`

REST `https://en.wikipedia.org/api/rest_v1/page/summary/{title}`. Tests: returns extract and canonical URL; a disambiguation page returns `None`; a 404 returns `None`. Commit: `"feat: wikipedia summary lookup"`.

### Task 22: RDAP lookup tool

**Files:** `src/research/tools/rdap.py`, `tests/test_rdap.py`, `tests/fixtures/rdap_example.json`

Fetch `https://rdap.org/domain/{domain}` (free, no key, follows the IANA bootstrap). Tests: extracts registrar from the `registrar` entity role; extracts registrant organization from the `registrant` role's vCard `org` field; detects privacy shielding (registrant org missing, or matching `/privacy|redacted|whois ?guard|proxy/i`) and sets `whois_privacy=True`; parses the `registration` event into `domain_created_at`; a 404 for an unknown TLD returns `None`; results are cached through `fetch_page`'s cache with a 30-day TTL.

Commit: `"feat: RDAP domain registration lookup"`.

### Task 23: ads.txt ownership signal

**Files:** `src/research/tools/ads_txt.py`, `tests/test_ads_txt.py`, `tests/fixtures/ads_sample.txt`

Fetch `https://{domain}/ads.txt`. Tests: parses `domain, publisher_id, DIRECT|RESELLER, cert` lines; ignores comments and blank lines; returns only the `DIRECT` relationships (those name the entity actually selling the inventory, i.e. the operator); returns an empty list on 404; handles a file with CRLF line endings.

Commit: `"feat: ads.txt direct-seller extraction"`.

### Task 24: Byline normalization

**Files:** `src/research/authors/byline.py`, `tests/test_byline.py`

Pure functions, no I/O — the cheapest high-value tests in the project.

**Step 1: Write the failing test**

```python
@pytest.mark.parametrize("raw,expected", [
    ("By Jane Doe", ["Jane Doe"]),
    ("by jane doe", ["Jane Doe"]),
    ("Jane Doe and John Smith", ["Jane Doe", "John Smith"]),
    ("Jane Doe, John Smith and Ana Ruiz", ["Jane Doe", "John Smith", "Ana Ruiz"]),
    ("Jane Doe | Political Correspondent", ["Jane Doe"]),
    ("By Jane Doe, CNN", ["Jane Doe"]),
    ("", []),
    ("   ", []),
])
def test_splits_and_cleans_bylines(raw, expected):
    assert split_byline(raw) == expected


@pytest.mark.parametrize("raw", ["Reuters", "Associated Press", "AP", "AFP", "Staff",
                                 "Editorial Board", "Newsroom", "Admin", "Guardian staff reporter"])
def test_detects_non_person_bylines(raw):
    assert is_person(raw) is False


@pytest.mark.parametrize("raw", ["Jane Doe", "Ana María Ruiz", "Seán Ó Broin", "Zhang Wei"])
def test_accepts_real_names(raw):
    assert is_person(raw) is True


def test_normalized_name_is_the_dedupe_key():
    assert normalize("  JANE   DOE ") == normalize("Jane Doe") == "jane doe"
    assert normalize("Ana María Ruiz") == "ana maria ruiz"  # accents folded
```

**Step 2–4:** implement, verify all parametrized cases pass.

**Step 5: Commit** — `git commit -am "feat: byline splitting, person detection and normalization"`

### Task 25: Ownership agent

**Files:**
- Create: `src/research/agents/ownership.py`, `src/research/db/ownership_repo.py`
- Create: `tests/test_ownership_agent.py`

**Step 1: Write the failing test**

```python
async def test_fresh_cache_entry_short_circuits_with_no_lookups():
    repo = FakeOwnershipRepo(existing=OwnershipProfile(domain="bbc.co.uk", owner_name="BBC",
                                                       refresh_after=in_days(30)))
    tools = RecordingTools()
    profile = await research_ownership("bbc.co.uk", repo=repo, tools=tools, llm=RaisingModel())
    assert profile.owner_name == "BBC"
    assert tools.calls == []


async def test_stale_cache_entry_is_re_researched():
    repo = FakeOwnershipRepo(existing=OwnershipProfile(domain="bbc.co.uk", refresh_after=in_days(-1)))
    tools = RecordingTools(wikidata=WikidataOrg(qid="Q9531", owner="BBC", country="United Kingdom"))
    await research_ownership("bbc.co.uk", repo=repo, tools=tools, llm=fake_llm())
    assert "wikidata" in tools.calls


async def test_wikidata_result_is_used_without_calling_the_llm():
    tools = RecordingTools(wikidata=WikidataOrg(qid="Q9531", owner="BBC", parent="BBC",
                                                country="United Kingdom", inception=1922))
    profile = await research_ownership("bbc.co.uk", repo=FakeOwnershipRepo(), tools=tools, llm=RaisingModel())
    assert profile.owner_name == "BBC"
    assert profile.confidence >= 0.8
    assert profile.evidence[0]["source_type"] == "wikidata"


async def test_falls_back_to_about_pages_and_llm_extraction():
    tools = RecordingTools(wikidata=None, pages={"https://small.news/about": "Small News is owned by Acme Media Ltd."})
    llm = fake_structured(OwnershipExtraction(owner_name="Acme Media Ltd", funding_type="private"))
    profile = await research_ownership("small.news", repo=FakeOwnershipRepo(), tools=tools, llm=llm)
    assert profile.owner_name == "Acme Media Ltd"
    assert profile.confidence < 0.8  # LLM extraction is less certain than wikidata


async def test_tries_every_about_path_until_one_returns():
    tools = RecordingTools(pages={"https://x.news/impressum": "Impressum: X GmbH"})
    await research_ownership("x.news", repo=FakeOwnershipRepo(), tools=tools, llm=fake_llm())
    assert "/about" in tools.attempted_paths and "/impressum" in tools.attempted_paths


async def test_marks_opaque_when_nothing_identifies_the_owner():
    tools = RecordingTools(wikidata=None, pages={}, rdap=Rdap(whois_privacy=True), ads_txt=[])
    profile = await research_ownership("anon.news", repo=FakeOwnershipRepo(), tools=tools, llm=fake_llm(empty=True))
    assert profile.is_opaque is True
    assert profile.owner_name is None


async def test_owner_group_key_is_a_stable_slug_of_the_ultimate_parent():
    a = await research_ownership("cnn.com", repo=FakeOwnershipRepo(),
                                 tools=RecordingTools(wikidata=WikidataOrg(parent="Warner Bros. Discovery")), llm=fake_llm())
    b = await research_ownership("hbo.com", repo=FakeOwnershipRepo(),
                                 tools=RecordingTools(wikidata=WikidataOrg(parent="Warner Bros Discovery, Inc.")), llm=fake_llm())
    assert a.owner_group_key == b.owner_group_key == "warner-bros-discovery"


async def test_a_tool_failure_degrades_instead_of_raising():
    tools = RecordingTools(wikidata=RaisesOnCall(), pages={"https://x.news/about": "Owned by Y"})
    profile = await research_ownership("x.news", repo=FakeOwnershipRepo(), tools=tools, llm=fake_llm())
    assert profile is not None
```

**Step 2: Run it to verify it fails.**

**Step 3: Implement**

Order: cache check → Wikidata → (if no owner) about-page sweep over `["/about", "/about-us", "/aboutus", "/about/", "/imprint", "/impressum", "/ownership", "/who-we-are", "/company"]` plus ads.txt plus RDAP → one LLM extraction over whatever text was gathered. Confidence: 0.9 Wikidata, 0.6 imprint/about extraction, 0.4 ads.txt or RDAP registrant only, 0.0 nothing. `owner_group_key` is `slugify(ultimate_parent or owner_name)` with corporate suffixes (`inc`, `ltd`, `llc`, `plc`, `gmbh`, `sa`, `nv`, `co`, `group`, `holdings`, `media`) and punctuation stripped. `is_opaque` when no Wikidata QID, no about/imprint page returned text, and `whois_privacy` is true.

**Step 4: Verify** — 8 passed. **Step 5: Commit** — `git commit -am "feat: publication ownership research agent"`

### Task 26: Author agent

**Files:** `src/research/agents/author.py`, `src/research/db/authors_repo.py`, `tests/test_author_agent.py`

**Step 1: Write the failing test**

Cover: a fresh cache entry short-circuits; a wire-service byline ("Reuters") is stored with `is_person=False` and makes no LLM call; the outlet author page is tried at `/author/{slug}`, `/authors/{slug}`, `/by/{slug}` and JSON-LD `sameAs` links are collected into `profile_urls`; a Wikidata person hit sets `wikidata_qid` and raises confidence; `article_count`, `first_seen_at` and `last_seen_at` come from `articles.records` for that `(domain, normalized_name)`; `beats` are derived from the distinct categories of that author's existing articles, not invented by the LLM; an empty byline returns `None` and the article keeps `author_id = NULL`; a co-authored byline resolves the **first** named person and records the rest in `evidence`.

**Step 2–4:** implement and verify.

**Step 5: Commit** — `git commit -am "feat: author research agent"`

### Task 27: Citation analysis

**Files:** `src/research/analysis/citations.py`, `tests/test_citations.py`

Deterministic, no LLM — it reads `articles.content.links` written in Task 6.

**Step 1: Write the failing test**

```python
def test_classifies_link_types():
    links = [
        {"url": "https://www.gov.uk/report", "anchor": "the report"},
        {"url": "https://www.who.int/data", "anchor": "WHO figures"},
        {"url": "https://arxiv.org/abs/1234", "anchor": "the study"},
        {"url": "https://www.bbc.co.uk/news/x", "anchor": "BBC reported"},
        {"url": "https://twitter.com/x/status/1", "anchor": "tweeted"},
        {"url": "https://news.example.com/other", "anchor": "our earlier story"},
        {"url": "https://shop.example.org/buy", "anchor": "buy now"},
    ]
    out = classify_links(links, article_domain="news.example.com", outlet_domains={"bbc.co.uk"})
    types = {c.url: c.link_type for c in out}
    assert types["https://www.gov.uk/report"] == "primary_source"
    assert types["https://www.who.int/data"] == "primary_source"
    assert types["https://arxiv.org/abs/1234"] == "primary_source"
    assert types["https://www.bbc.co.uk/news/x"] == "outlet"
    assert types["https://twitter.com/x/status/1"] == "social"
    assert types["https://news.example.com/other"] == "self"
    assert types["https://shop.example.org/buy"] == "other"


def test_self_links_are_not_external():
    (c,) = classify_links([{"url": "https://news.example.com/x", "anchor": None}],
                          article_domain="news.example.com", outlet_domains=set())
    assert c.is_external is False


def test_citation_score_rewards_primary_sources_over_volume():
    many_social = [social_link(i) for i in range(20)]
    two_primary = [gov_link(1), gov_link(2)]
    assert citation_score(classify(two_primary)) > citation_score(classify(many_social))


def test_citation_score_of_an_article_with_no_links_is_low_but_not_zero():
    assert 0.0 < citation_score([]) <= 0.35
```

`primary_source` matches government (`.gov`, `.gov.uk`, `.gouv.fr`), intergovernmental (`who.int`, `un.org`, `europa.eu`), academic (`.edu`, `.ac.uk`, `arxiv.org`, `doi.org`, `nature.com`, `pubmed.ncbi.nlm.nih.gov`), and court/legislature domains — the list lives in `src/research/analysis/primary_sources.py` so it can grow without touching logic. `outlet_domains` comes from `sources.records`.

**Step 2–4:** implement, verify. **Step 5: Commit** — `git commit -am "feat: outbound citation classification and scoring"`

### Task 28: Publication history

**Files:** `src/research/analysis/history.py`, `tests/test_history.py`

SQL over `articles.records`, guarded by `requires_db`. Returns, for the article's domain: article count in the last 90 days, distinct categories, mean `overall_truthfulness`; and for the resolved author: article count, top categories, first and last seen dates. Tests: an unknown domain returns zeroed stats rather than `None`; the current article is excluded from its own history; categories are ordered by frequency.

Commit: `"feat: publication and author history stats"`.

### Task 29: Corroboration diversity check

**Files:** `src/research/analysis/diversity.py`, `tests/test_diversity.py`

**Step 1: Write the failing test**

```python
async def test_matches_sharing_an_owner_collapse_to_one_independent_source():
    matches = [m("thetimes.co.uk"), m("thesun.co.uk"), m("bbc.co.uk")]
    ownership = {"thetimes.co.uk": "news-corp", "thesun.co.uk": "news-corp", "bbc.co.uk": "bbc"}
    result = await apply_diversity(matches, article_domain="reuters.com", ownership=ownership)
    assert result.distinct_owner_count == 2
    assert [m.is_independent for m in result.matches] == [True, False, True]


async def test_a_match_owned_by_the_articles_own_publisher_is_not_independent():
    matches = [m("thesun.co.uk")]
    ownership = {"thesun.co.uk": "news-corp", "thetimes.co.uk": "news-corp"}
    result = await apply_diversity(matches, article_domain="thetimes.co.uk", ownership=ownership)
    assert result.matches[0].is_independent is False
    assert result.distinct_owner_count == 0


async def test_unknown_ownership_is_treated_as_independent():
    result = await apply_diversity([m("unknown.news")], article_domain="x.com", ownership={})
    assert result.matches[0].is_independent is True


async def test_the_first_match_of_an_owner_group_keeps_independence():
    matches = [m("a.com"), m("b.com")]
    result = await apply_diversity(matches, "x.com", ownership={"a.com": "g", "b.com": "g"})
    assert [x.is_independent for x in result.matches] == [True, False]
```

**Step 2–4:** implement, verify. **Step 5: Commit** — `git commit -am "feat: corroboration ownership diversity check"`

### Task 30: Scoring

**Files:** `src/research/analysis/scoring.py`, `tests/test_scoring.py`

Writes only the six existing `articles.truthfulness_scores` columns — no new sub-scores, per the design.

| Column | Source |
|---|---|
| `bias_indicator` | classification `bias_score / 100` |
| `language_quality` | classification `language_score / 100` |
| `source_citation_quality` | `0.6 × citation_score + 0.4 × corroboration_score`, where `corroboration_score` is driven by **distinct owner count** (0 → 0.0, 1 → 0.5, 2 → 0.7, 3–4 → 0.85, 5+ → 1.0) |
| `factual_accuracy` | source trust score from `sources.records.trust_score`, adjusted ±0.1 by the supports/contradicts balance of matches |
| `claim_verifiability` | primary-source citation ratio blended with word count |
| `overall_truthfulness` | `mean(factual, citation, 1 − bias, claim, language)` — unchanged formula |

Tests: each column's formula at its boundaries; a `None` input propagates as `None` rather than becoming 0; contradicting matches lower `factual_accuracy` below the raw trust score; five same-owner matches score the same as one; `overall_truthfulness` ignores `None` components; every value is rounded to 4 decimal places to fit `NUMERIC(5,4)`.

Commit: `"feat: truthfulness scoring from research signals"`.

### Task 31: Persistence

**Files:** `src/research/db/persist.py`, `tests/test_persist.py` (`requires_db`)

One transaction writing: `articles.records` (`category`, `status`, `author_id`), `articles.truthfulness_scores` (upsert on `(article_id, search_subject)`), `articles.similar_articles` (delete-then-insert for the article, including `owner_group_key`, `is_independent`, `stance`, `excerpt`), `articles.citations` (delete-then-insert), `sources.ownership` upsert, `authors.records` upsert, and one `articles.research_runs` row.

Tests: a mid-transaction failure rolls back *everything*, leaving the article untouched; re-running is idempotent and does not duplicate similar articles or citations; `status` becomes `rejected` when category is `None`, `unverified` when there are no matches on the final attempt, `approved` otherwise; `search_subject` falls back to `'unknown'` when the job has no `search_term`, matching current behaviour.

Commit: `"feat: transactional persistence of research results"`.

### Task 32: Assemble the LangGraph pipeline

**Files:** `src/research/graph.py`, `tests/test_graph.py`

**Step 1: Write the failing test**

```python
async def test_off_topic_article_is_rejected_before_any_research_runs():
    nodes = RecordingNodes(classification=ContentClassification(category=None, bias_score=None, language_score=None))
    result = await run_graph(job, nodes=nodes)
    assert result.status == "rejected"
    assert nodes.ran == ["classify"]


async def test_research_nodes_run_in_parallel_after_the_topic_gate():
    nodes = RecordingNodes()
    await run_graph(job, nodes=nodes)
    assert set(nodes.ran) == {"classify", "ownership", "author", "citations", "corroboration",
                              "history", "diversity", "score", "persist"}


async def test_one_failing_research_node_does_not_fail_the_run():
    nodes = RecordingNodes(ownership=Raises("wikidata down"))
    result = await run_graph(job, nodes=nodes)
    assert result.status in {"approved", "unverified"}
    assert "ownership" in result.node_errors
    assert result.ownership is None


async def test_a_persistence_failure_propagates_so_the_job_retries():
    nodes = RecordingNodes(persist=Raises("db down"))
    with pytest.raises(Exception):
        await run_graph(job, nodes=nodes)


async def test_no_matches_on_the_final_attempt_marks_the_article_unverified():
    result = await run_graph(job_on_last_attempt, nodes=RecordingNodes(matches=[]))
    assert result.status == "unverified"


async def test_no_matches_before_the_final_attempt_raises_so_the_job_requeues():
    with pytest.raises(NoCorroborationError):
        await run_graph(job_first_attempt, nodes=RecordingNodes(matches=[]))
```

**Step 2: Run it to verify it fails.**

**Step 3: Implement**

`ResearchState` is a `TypedDict` with the article fields plus one key per node output and a `node_errors: dict[str, str]`. Wrap every research node in a decorator that catches exceptions, records them under `node_errors`, and returns an empty partial state — only `persist` is allowed to raise. Edges follow the design diagram: `classify → gate → {ownership, author, citations, corroboration, history} → diversity → score → persist`. Wire `run_graph` into `ResearchWorker` in `__main__.py`, replacing the placeholder callable from Task 13.

**Step 4: Verify**

```bash
uv run pytest -v
uv run ruff check .
```
Expected: the full suite passes.

**Step 5: Commit** — `git commit -am "feat: assemble the research graph and wire it to the worker"`

---

# Phase 5 — Parity, cutover, cleanup

### Task 33: Parity run against the old pipeline

**Files:**
- Create: `scripts/parity_check.py` (in `truth-accord-research`)
- Create: `docs/parity-2026-08-17.md`

**Step 1: Collect a sample**

Pick 30 already-processed articles that have both a category and scores:

```bash
psql "$DATABASE_URL" -At -F'|' -c "
  SELECT r.id, r.url, r.category, s.bias_indicator, s.language_quality
  FROM articles.records r
  JOIN articles.truthfulness_scores s ON s.article_id = r.id
  WHERE r.category IS NOT NULL AND r.status = 'approved'
  ORDER BY r.recorded_at DESC LIMIT 30" > /tmp/parity_sample.txt
```

**Step 2: Run the new chains over the same articles**

`scripts/parity_check.py` reads that file, pulls each article's stored `title`, `summary` and `articles.content.text`, runs `build_classify_chain` only (no persistence, no research), and prints a comparison table plus three aggregates: category agreement rate, mean absolute difference in `bias_indicator`, mean absolute difference in `language_quality`.

Run: `uv run python scripts/parity_check.py /tmp/parity_sample.txt`

**Step 3: Judge the result**

Acceptance thresholds — these are the gate for deleting the TS code:

- category agreement ≥ 80% (both are the same model and prompt; large drift means the port changed the prompt)
- mean absolute bias difference ≤ 0.10
- mean absolute language difference ≤ 0.10

If a threshold misses, diff the generated prompt against `src/services/ollama.service.ts:66-88` in the TS repo before changing anything else — the cause is almost always a prompt wording change, not the structured-output switch.

**Step 4: Record it**

Write the table and the three aggregates to `docs/parity-2026-08-17.md`.

**Step 5: Commit** — `git add -A && git commit -m "test: parity check of ported classification chain"`

### Task 34: Delete the TypeScript LLM code

Only after Task 33 passes. In `/home/brandee/repos/truth-accord-background-worker`.

**Files:**
- Delete: `src/services/ollama.service.ts`, `src/services/ollama.service.test.ts`
- Delete: `src/services/truthfulness/truthfulness.service.ts`, `src/services/truthfulness/reference-sites-crawl.service.ts`, `src/services/truthfulness/reference-sites-crawl.test.ts`
- Delete: `src/services/topic-classifier.ts`, `src/services/topic-classifier.test.ts`, `src/config/topic-filter.config.ts`, `src/config/reference.config.ts`
- Delete: `src/repositories/article-truthfulness-scores.repository.ts`, `src/repositories/similar-articles.repository.ts`, `src/repositories/reference-sites.repository.ts`
- Modify: `src/index.ts`, `src/types.ts`, `src/workers/rss-feed.worker.ts`

**Step 1: Check what still references each file**

```bash
cd /home/brandee/repos/truth-accord-background-worker
for f in ollama.service truthfulness.service reference-sites-crawl topic-classifier; do
  echo "== $f"; grep -rn "$f" src/ --include='*.ts' | grep -v "^src/.*/$f"
done
```

`rss-feed.worker.ts` imports `classifyTopic` for RSS category mapping. It stays a TS worker, so keep `topic-classifier.ts` and `topic-filter.config.ts` **if** that import survives; delete them only if the RSS worker no longer classifies. Confirm before deleting.

**Step 2: Delete and clean up**

Remove the files, then strip the now-unused types from `src/types.ts` (`TruthfulnessMetrics`, `OllamaContentScores`, `OllamaSimilarArticlesScore`, `TruthfulnessScoreRow`, `SimilarArticleRow`) and the corresponding constructions in `src/index.ts`.

**Step 3: Verify nothing dangles**

```bash
npm run typecheck
npm run lint
npm test
```
Expected: all pass with no unused-import or unresolved-module errors.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove TypeScript LLM and heuristic scoring, now owned by the research service"
```

### Task 35: Documentation and deployment

**Files:**
- Modify: `README.md` (background worker), `.env.example` (background worker)
- Create: `README.md` (research service), `Dockerfile` (research service)

**Step 1: Background worker README**

Rewrite the "Processing pipeline" section to the four scrape steps and add a "Handoff" section explaining that `research_article` jobs are processed by `truth-accord-research`. Remove `OLLAMA_*`, `SEARCH_FEED_TIMEOUT_MS`, `REFERENCE_*` and `SIMILAR_ARTICLE_MIN_SCORE` from `.env.example` — they now live in the research service.

**Step 2: Research service README**

Cover: what it does, the graph diagram from the design doc, every environment variable, how to run (`uv run python -m research`), how to queue a job by hand:

```sql
INSERT INTO worker.jobs (type, payload)
VALUES ('research_article', jsonb_build_object('article_id', '<uuid>', 'url', '<url>', 'search_term', NULL));
```

and how to re-research an article (delete the `research_runs` row, reset the job).

**Step 3: Dockerfile**

`python:3.12-slim`, `uv sync --frozen --no-dev`, `CMD ["python", "-m", "research"]`, `EXPOSE 8081`, `HEALTHCHECK` against `/health`.

**Step 4: Verify the whole thing end to end**

With both services running against the scratch database:

```bash
psql "$DATABASE_URL" -c "INSERT INTO worker.jobs (type, payload) VALUES ('scrape_url', '{\"url\": \"https://www.bbc.co.uk/news\", \"search_term\": \"test\"}');"
```

Then confirm, in order: the scrape job completes; an `articles.content` row exists; a `research_article` job appears and is claimed; and finally the article has a category, scores, similar articles, a `sources.ownership` row for `bbc.co.uk` and an `authors.records` row.

```bash
psql "$DATABASE_URL" -c "
  SELECT r.status, r.category, o.owner_name, o.owner_group_key, a.name AS author,
         (SELECT COUNT(*) FROM articles.similar_articles s WHERE s.article_id = r.id) AS matches,
         (SELECT COUNT(*) FROM articles.citations c WHERE c.article_id = r.id) AS citations
  FROM articles.records r
  LEFT JOIN sources.ownership o ON o.domain = r.source
  LEFT JOIN authors.records a ON a.id = r.author_id
  ORDER BY r.recorded_at DESC LIMIT 1"
```

**Step 5: Commit** — in each repo separately:

```bash
git commit -am "docs: document the scrape/research split"
```

---

## Notes for the implementer

- **Do not skip the parity run.** It is the only thing standing between a prompt-wording regression and silently different scores across the whole corpus.
- **`worker.jobs.url_hash` is globally unique, not per-type.** Research jobs must never set it.
- **Research is best-effort; persistence is not.** Only `persist` and database errors may fail a job. A failed Wikidata lookup is a `node_errors` entry, not an exception.
- **Ownership and author research are cached.** Most jobs should hit the cache and do no external lookups at all. If you see a Wikidata call on every job, the TTL logic is broken.
- **Do not add truthfulness sub-score columns.** The design deliberately stores ownership and author findings without scoring them yet; the only place ownership affects a score is the diversity input to `source_citation_quality`.
- **When Ollama is down, jobs retry and eventually go dead.** That is intended. Do not reintroduce heuristic fallbacks.
