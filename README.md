# truth-accord-background-worker

Polls `worker.jobs` for `scrape_url` jobs and runs the full article processing pipeline: scraping → paywall detection → Wayback fallback → truthfulness scoring → similar article matching.

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

1. Fetch and parse the article URL (static HTML first, falls back to headless browser for JS-heavy pages)
2. Detect paywall signals — if paywalled, fetch the latest Wayback Machine snapshot instead
3. Upsert the article into `articles.records`
4. Crawl RSS feeds of trusted reference sites for similar articles (keyword-based matching)
5. Compute truthfulness scores and write to `articles.truthfulness_scores`
6. Save matching reference articles to `articles.similar_articles`

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
SELECT status, COUNT(*) FROM worker.jobs WHERE type = 'scrape_url' GROUP BY status;
```

## DB migration

Before running, apply the migration in `truth-accord-db`:

```
20260610000009_articles_sources_schema.sql
```

This adds `published_at`, `is_archived`, `snapshot_timestamp`, `word_count` columns to `articles.records`, a unique constraint on `articles.records.url`, and creates the `sources.domains` table.

## Type check

```bash
npm run typecheck
```
