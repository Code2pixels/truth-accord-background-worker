# truth-accord-background-worker

Polls `worker.jobs` and dispatches jobs to typed handlers. Supports scheduled jobs via `worker.schedules`.

## Setup

```bash
cp .env.example .env
# edit .env and set DATABASE_URL
npm install
```

## Running

```bash
# development (watch mode, restarts on file changes)
npm run dev

# production
npm run start
```

Requires one environment variable:

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgres://user:password@localhost:5432/truth_accord` |

## Job types

| Type | Payload | Description |
|---|---|---|
| `scrape_url` | `{ url, selector? }` | Fetches a URL, extracts article metadata, inserts into `articles.records` |
| `rss_fetch` | `{ feedUrl }` | Parses an RSS/Atom feed and inserts each item into `articles.records` |
| `csv_ingest` | `{ filePath, delimiter? }` | Reads a CSV file and inserts each row into `articles.records`. Expected columns: `url`, `title`, `summary`, `authored_by`, `source`, `source_url` (only `url` and `title` are required) |
| `browser_scrape` | `{ url, waitFor? }` | Renders a page in a headless Chromium browser, extracts article metadata, inserts into `articles.records` |

## Tests

```bash
npm test
```

## Type check

```bash
npm run typecheck
```
