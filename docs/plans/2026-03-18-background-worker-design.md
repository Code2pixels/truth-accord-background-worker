# Background Worker Design

**Date:** 2026-03-18
**Status:** Approved

## Overview

A TypeScript/Node.js background worker that processes scheduled and on-demand jobs backed by PostgreSQL. Jobs can range from simple HTTP scraping to headless browser automation, RSS feed ingestion, and CSV processing.

## Stack

- **Runtime:** Node.js + TypeScript
- **Database:** PostgreSQL (own `worker` schema)
- **Dependencies:** `pg`, `node-cron`, `cron-parser`, `playwright`, `csv-parse`, `fast-xml-parser`

No Redis. No ORMs. No `any` types.

## Database Schema

All tables live in the `worker` schema.

### `worker.jobs`

Every job instance — one-off or spawned from a schedule.

```sql
id            uuid primary key
type          text              -- 'scrape_url' | 'rss_fetch' | 'csv_ingest' | 'browser_scrape'
payload       jsonb             -- job-specific config, fully typed in TypeScript
status        text              -- pending | running | completed | failed | dead
scheduled_at  timestamptz       -- when the job should run (defaults to now())
started_at    timestamptz
completed_at  timestamptz
attempts      int default 0
max_attempts  int default 3
last_error    text
created_at    timestamptz default now()
```

### `worker.schedules`

Recurring job definitions driven by cron expressions.

```sql
id            uuid primary key
type          text              -- matches a registered job handler type
payload       jsonb
cron          text              -- e.g. '0 * * * *'
enabled       bool default true
last_run_at   timestamptz
next_run_at   timestamptz       -- kept for monitoring/display purposes
created_at    timestamptz default now()
```

## Architecture

Three concurrent loops run inside a single Node.js process:

```
┌─────────────────────────────────────────┐
│              Worker Process              │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │Scheduler │  │Executor  │  │Reaper  │ │
│  │  loop    │  │  loop    │  │  loop  │ │
│  │ (30s)    │  │  (5s)    │  │ (60s)  │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
└───────┼──────────────┼────────────┼──────┘
        └──────────────▼────────────┘
                  PostgreSQL
                 worker schema
```

### Scheduler Loop
- Loads all enabled schedules from `worker.schedules` on startup and registers each as a `node-cron` task
- When a cron fires: inserts a row into `worker.jobs`, updates `last_run_at` and `next_run_at` (calculated via `cron-parser`)
- Dynamically registers/deregisters tasks when schedules are added or modified at runtime

### Executor Loop
- Polls every 5 seconds: `SELECT FOR UPDATE SKIP LOCKED` to claim a batch of `pending` jobs with `scheduled_at <= now()`
- Dispatches each claimed job to its registered handler concurrently (configurable concurrency limit)
- Writes `completed` or `failed` result back to the DB

### Reaper Loop
- Runs every 60 seconds
- Finds jobs stuck in `running` beyond their `timeoutMs` threshold and resets them to `pending`
- Allows recovery from crashed or hung handlers without manual intervention

## Job Handler Interface

```typescript
interface JobPayload {
  scrape_url:     { url: string; selector?: string }
  rss_fetch:      { feedUrl: string }
  csv_ingest:     { filePath: string; delimiter?: string }
  browser_scrape: { url: string; waitFor?: string }
}

type JobType = keyof JobPayload

interface JobHandler<T extends JobType> {
  type: T
  maxAttempts?: number
  timeoutMs?: number
  run: (payload: JobPayload[T]) => Promise<void>
}
```

Handlers are registered in a typed map — no `any` escapes.

## Job Lifecycle

```
pending → running → completed
                 ↘ failed → pending (if attempts < max_attempts, with exponential backoff)
                          → dead   (if attempts >= max_attempts)
```

- **Exponential backoff:** 30s → 2m → 10m between retry attempts
- **Dead jobs:** preserved in the DB for inspection, never retried automatically but can be manually reset to `pending`
- **Reaper:** resets `running` jobs that exceed `timeoutMs` back to `pending`
- **Graceful shutdown:** SIGTERM/SIGINT drains in-flight jobs before exit
- **Handler errors:** always caught, written to `last_error` as a stack trace string — unhandled rejections never crash the process

## Built-in Job Handlers

| Type | Description | Notes |
|---|---|---|
| `scrape_url` | Fetches a URL via `fetch`, extracts content by CSS selector | No browser needed |
| `rss_fetch` | Fetches and parses an RSS/Atom feed | Uses `fast-xml-parser` |
| `csv_ingest` | Streams a CSV file from disk | Uses `csv-parse` streams to handle large files |
| `browser_scrape` | Launches Playwright Chromium, navigates to URL, waits for selector | Browser launched and torn down per job in a `finally` block |

## Project Structure

```
src/
  db/
    client.ts          — pg pool setup
    migrations/        — SQL migration files
  worker/
    scheduler.ts       — node-cron registration and schedule management
    executor.ts        — polling loop and job dispatch
    reaper.ts          — stuck job recovery
  handlers/
    scrape-url.ts
    rss-fetch.ts
    csv-ingest.ts
    browser-scrape.ts
  types/
    jobs.ts            — JobPayload map, JobType, JobHandler interface
  index.ts             — entry point, wires everything together
```

## Key Constraints

- No `any` types anywhere in the codebase
- No Redis or external broker — PostgreSQL is the only required service
- Six production dependencies maximum
- All handlers must clean up resources (browsers, streams) in `finally` blocks
