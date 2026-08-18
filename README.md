# truth-accord-background-worker

Polls `worker.jobs` for `scrape_url` jobs and scrapes articles: scraping → paywall detection → Wayback fallback → store body text and outbound links → enqueue a `research_article` job.

All AI work — classification, corroboration, author and ownership research, truthfulness scoring — belongs to [`truth-accord-research`](../truth-accord-research), a Python LangGraph service that claims the `research_article` jobs this worker creates. The two services never talk directly; the `worker.jobs` table is the only interface.

## Setup

```bash
cp .env.example .env
# edit .env and set DATABASE_URL
npm install
```

Required environment variable:

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgres://user:password@localhost:5432/truth_accord` |

Optional tuning variables:

| Variable | Default | Description |
|---|---|---|
| `QUEUE_POLL_INTERVAL_MS` | `5000` | How often (ms) to poll for new jobs |
| `QUEUE_CONCURRENCY` | `3` | Max jobs processed in parallel |
| `MAX_RETRIES` | `3` | Max attempts before a job is marked dead |
| `SCRAPER_TIMEOUT_MS` | `30000` | HTTP/browser fetch timeout |
| `PLAYWRIGHT_HEADLESS` | `true` | Set to `false` to show browser window |

## Running

```bash
# development (watch mode)
npm run dev

# production
npm run start
```

The worker starts two loops:

- **ScrapeWorker** — polls `worker.jobs` every `QUEUE_POLL_INTERVAL_MS` ms, claims pending `scrape_url` jobs and runs the full pipeline
- **WaybackRecheckWorker** — runs nightly at 3am, re-queues failed jobs where a Wayback Machine snapshot is now available

## Processing pipeline

For each `scrape_url` job:

1. Fetch and parse the article URL (static HTML first, falls back to headless browser for JS-heavy pages), extracting body text and every outbound link with its anchor text
2. Detect paywall signals — if paywalled, fetch the latest Wayback Machine snapshot instead
3. Ensure the source domain is tracked in `sources.records`
4. Upsert the article into `articles.records` with `status='pending'` and `category=NULL`, write the body and links to `articles.content`, then enqueue a `research_article` job

The worker makes no LLM calls and computes no scores.

## Handoff to the research service

Step 4 inserts one row per article:

```sql
INSERT INTO worker.jobs (type, payload)
VALUES ('research_article', jsonb_build_object(
  'article_id', '<uuid>', 'url', '<url>', 'search_term', '<term or null>'));
```

`truth-accord-research` claims those jobs, runs its graph, and writes the final
`category`, `status`, scores, similar articles, citations, author and ownership rows.
Until it has run, an article stays `pending` with a null category — that is expected,
not a failure.

Research jobs never set `url_hash` (which is globally unique and owned by the scrape
job); they dedupe on a partial unique index over `payload->>'article_id'`, so the
insert is a no-op when research for that article is already queued or running.

## Queueing jobs manually

Insert a row into `worker.jobs` — the worker picks it up within `QUEUE_POLL_INTERVAL_MS` ms:

```sql
-- Scrape a URL (search_term is used as the score subject label)
INSERT INTO worker.jobs (type, payload)
VALUES ('scrape_url', '{"url": "https://example.com/article", "search_term": "climate policy"}');

-- Scrape and mark the article as approved immediately
INSERT INTO worker.jobs (type, payload)
VALUES ('scrape_url', '{"url": "https://example.com/article", "status": "approved"}');

-- Schedule a future run
INSERT INTO worker.jobs (type, payload, scheduled_at)
VALUES ('scrape_url', '{"url": "https://example.com/article"}', NOW() + INTERVAL '1 hour');
```

To retry a dead or failed job:

```sql
UPDATE worker.jobs
SET status = 'pending', scheduled_at = NOW(), attempts = 0
WHERE id = '<job-id>';
```

To check queue stats:

```sql
SELECT type, status, COUNT(*) FROM worker.jobs GROUP BY type, status ORDER BY type, status;
```

## DB migrations

Apply the migrations in `truth-accord-db`. Beyond the original
`20260610000009_articles_sources_schema.sql` (which adds `published_at`, `is_archived`,
`snapshot_timestamp` and `word_count` to `articles.records`, a unique constraint on
`articles.records.url`, and the `sources.domains` table), the scrape/research split needs:

| Migration | Adds |
|---|---|
| `20260817000021_articles_content.sql` | `articles.content` — body text and outbound links |
| `20260817000022_sources_ownership.sql` | `sources.ownership` |
| `20260817000023_authors_records.sql` | `authors.records`, `articles.records.author_id` |
| `20260817000024_similar_articles_research.sql` | ownership, stance and excerpt on `articles.similar_articles` |
| `20260817000025_research_support_tables.sql` | `articles.citations`, `research.fetch_cache`, `articles.research_runs`, `worker.jobs.heartbeat_at` and the research-job unique index |

This worker needs `articles.content` and the `worker.jobs` changes; the rest are used
by the research service.

## Type check

```bash
npm run typecheck
```
