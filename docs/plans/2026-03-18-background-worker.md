# Background Worker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a TypeScript/Node.js background worker that processes scheduled and on-demand jobs (scraping, RSS, CSV, headless browser) backed by PostgreSQL with no external broker.

**Architecture:** Three concurrent loops (Scheduler, Executor, Reaper) run in a single Node.js process. Jobs are persisted in a `worker` PostgreSQL schema and claimed atomically via `SELECT FOR UPDATE SKIP LOCKED`. Cron schedules are loaded from the DB on startup and registered with `node-cron`.

**Tech Stack:** TypeScript, Node.js, `pg`, `node-cron`, `cron-parser`, `playwright`, `csv-parse`, `fast-xml-parser`. Dev: `typescript`, `tsx`, `@types/pg`, `@types/node`.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/` (directory)

**Step 1: Create `package.json`**

```json
{
  "name": "truth-accord-background-worker",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "test": "node --import tsx/esm --test 'src/**/*.test.ts'",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "csv-parse": "^5.5.6",
    "cron-parser": "^4.9.0",
    "fast-xml-parser": "^4.4.1",
    "node-cron": "^3.0.3",
    "pg": "^8.13.1",
    "playwright": "^1.50.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/node-cron": "^3.0.11",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node10",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Install dependencies**

```bash
npm install
npx playwright install chromium
```

Expected: `node_modules/` created, no errors.

**Step 4: Create directory structure**

```bash
mkdir -p src/db/migrations src/worker src/handlers src/types
```

**Step 5: Verify TypeScript works**

Create `src/index.ts` with just `export {}` and run:

```bash
npm run typecheck
```

Expected: no output (no errors).

**Step 6: Commit**

```bash
git add package.json tsconfig.json src/index.ts
git commit -m "chore: scaffold project with deps and tsconfig"
```

---

### Task 2: Core Types

**Files:**
- Create: `src/types/jobs.ts`
- Create: `src/types/jobs.test.ts`

**Step 1: Write the failing test**

`src/types/jobs.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKOFF_SECONDS, backoffDelay } from './jobs.ts'

test('backoffDelay returns 30s for first attempt', () => {
  assert.equal(backoffDelay(1), 30)
})

test('backoffDelay returns 120s for second attempt', () => {
  assert.equal(backoffDelay(2), 120)
})

test('backoffDelay returns 600s for third and beyond', () => {
  assert.equal(backoffDelay(3), 600)
  assert.equal(backoffDelay(99), 600)
})

test('BACKOFF_SECONDS has correct values', () => {
  assert.deepEqual(BACKOFF_SECONDS, [30, 120, 600])
})
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `backoffDelay` not found.

**Step 3: Write `src/types/jobs.ts`**

```typescript
export interface JobPayload {
  scrape_url: { url: string; selector?: string }
  rss_fetch: { feedUrl: string }
  csv_ingest: { filePath: string; delimiter?: string }
  browser_scrape: { url: string; waitFor?: string }
}

export type JobType = keyof JobPayload

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead'

export interface JobRow {
  id: string
  type: JobType
  payload: JobPayload[JobType]
  status: JobStatus
  scheduled_at: Date
  started_at: Date | null
  completed_at: Date | null
  attempts: number
  max_attempts: number
  last_error: string | null
  created_at: Date
}

export interface ScheduleRow {
  id: string
  type: JobType
  payload: JobPayload[JobType]
  cron: string
  enabled: boolean
  last_run_at: Date | null
  next_run_at: Date | null
  created_at: Date
}

export interface JobHandler<T extends JobType> {
  type: T
  maxAttempts?: number
  timeoutMs?: number
  run: (payload: JobPayload[T]) => Promise<void>
}

export type HandlerRegistry = {
  [T in JobType]?: JobHandler<T>
}

export const BACKOFF_SECONDS = [30, 120, 600] as const

export function backoffDelay(attempts: number): number {
  const index = Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
  return BACKOFF_SECONDS[index] ?? 600
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: all 4 tests PASS.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/types/jobs.ts src/types/jobs.test.ts
git commit -m "feat: add core job types and backoff logic"
```

---

### Task 3: Database Client

**Files:**
- Create: `src/db/client.ts`

The DB client wraps a `pg.Pool`. It reads `DATABASE_URL` from the environment. No test for this task — it's pure wiring and will be exercised by integration tests in later tasks.

**Step 1: Write `src/db/client.ts`**

```typescript
import { Pool } from 'pg'

if (!process.env['DATABASE_URL']) {
  throw new Error('DATABASE_URL environment variable is required')
}

export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
})

pool.on('error', (err: Error) => {
  console.error('Unexpected pg pool error', err)
})
```

**Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/db/client.ts
git commit -m "feat: add pg pool client"
```

---

### Task 4: Database Migration

**Files:**
- Create: `src/db/migrations/001_worker_schema.sql`
- Create: `src/db/migrate.ts`

**Step 1: Write `src/db/migrations/001_worker_schema.sql`**

```sql
CREATE SCHEMA IF NOT EXISTS worker;

CREATE TABLE IF NOT EXISTS worker.jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead')),
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  attempts      INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 3,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jobs_status_scheduled_at
  ON worker.jobs (status, scheduled_at);

CREATE INDEX IF NOT EXISTS jobs_status_started_at
  ON worker.jobs (status, started_at);

CREATE TABLE IF NOT EXISTS worker.schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  cron        TEXT NOT NULL,
  enabled     BOOL NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS worker.migrations (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Step 2: Write `src/db/migrate.ts`**

```typescript
import fs from 'node:fs'
import path from 'node:path'
import { pool } from './client.ts'

export async function migrate(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS worker.migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const migrationsDir = path.join(__dirname, 'migrations')
    const files = fs.readdirSync(migrationsDir).sort()

    for (const file of files) {
      if (!file.endsWith('.sql')) continue

      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM worker.migrations WHERE name = $1',
        [file]
      )

      if (rows.length > 0) continue

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      await client.query('BEGIN')
      await client.query(sql)
      await client.query(
        'INSERT INTO worker.migrations (name) VALUES ($1)',
        [file]
      )
      await client.query('COMMIT')
      console.log(`Applied migration: ${file}`)
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

**Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 4: Run migration against your local DB**

Set `DATABASE_URL` in a `.env` file (never commit this file):

```
DATABASE_URL=postgres://user:password@localhost:5432/your_db
```

Then run:

```bash
DATABASE_URL=postgres://user:password@localhost:5432/your_db tsx src/db/migrate.ts
```

Or create a quick runner script:

```bash
node -e "require('tsx/cjs'); require('./src/db/migrate.ts').migrate().then(() => { console.log('done'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"
```

Expected: `Applied migration: 001_worker_schema.sql` printed, tables exist in DB.

**Step 5: Commit**

```bash
git add src/db/migrations/001_worker_schema.sql src/db/migrate.ts
git commit -m "feat: add worker schema migration"
```

---

### Task 5: Executor

**Files:**
- Create: `src/worker/executor.ts`
- Create: `src/worker/executor.test.ts`

The executor polls for pending jobs, claims them atomically, and dispatches to handlers.

**Step 1: Write the failing test**

`src/worker/executor.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExecutor } from './executor.ts'
import type { HandlerRegistry, JobPayload } from '../types/jobs.ts'

test('executor calls the correct handler for a job type', async () => {
  const calls: string[] = []

  const registry: HandlerRegistry = {
    scrape_url: {
      type: 'scrape_url',
      run: async (payload: JobPayload['scrape_url']) => {
        calls.push(payload.url)
      },
    },
  }

  // Simulate a single dispatch (not the poll loop)
  const { dispatch } = buildExecutor(registry)

  await dispatch({
    id: 'test-id',
    type: 'scrape_url',
    payload: { url: 'https://example.com' },
    status: 'running',
    scheduled_at: new Date(),
    started_at: new Date(),
    completed_at: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    created_at: new Date(),
  })

  assert.deepEqual(calls, ['https://example.com'])
})

test('executor records error when handler throws', async () => {
  const errors: string[] = []

  const registry: HandlerRegistry = {
    scrape_url: {
      type: 'scrape_url',
      run: async () => {
        throw new Error('network timeout')
      },
    },
  }

  const { dispatch } = buildExecutor(registry, {
    onError: (id, err) => errors.push(`${id}:${err.message}`),
  })

  await dispatch({
    id: 'job-1',
    type: 'scrape_url',
    payload: { url: 'https://example.com' },
    status: 'running',
    scheduled_at: new Date(),
    started_at: new Date(),
    completed_at: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    created_at: new Date(),
  })

  assert.deepEqual(errors, ['job-1:network timeout'])
})
```

**Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `buildExecutor` not found.

**Step 3: Write `src/worker/executor.ts`**

```typescript
import { pool } from '../db/client.ts'
import { backoffDelay } from '../types/jobs.ts'
import type { HandlerRegistry, JobRow, JobType } from '../types/jobs.ts'

const POLL_INTERVAL_MS = 5_000
const BATCH_SIZE = 10

interface ExecutorOptions {
  concurrency?: number
  onError?: (jobId: string, err: Error) => void
}

interface Executor {
  dispatch: (job: JobRow) => Promise<void>
  start: () => void
  stop: () => void
}

export function buildExecutor(
  registry: HandlerRegistry,
  options: ExecutorOptions = {}
): Executor {
  const { concurrency = 5, onError } = options
  let running = false
  let timer: NodeJS.Timeout | null = null

  async function dispatch(job: JobRow): Promise<void> {
    const handler = registry[job.type as JobType]
    if (!handler) {
      await markFailed(job.id, job.attempts, job.max_attempts, new Error(`No handler for job type: ${job.type}`))
      return
    }

    try {
      await (handler as { run: (p: JobRow['payload']) => Promise<void> }).run(job.payload)
      await markCompleted(job.id)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      onError?.(job.id, error)
      await markFailed(job.id, job.attempts, job.max_attempts, error)
    }
  }

  async function poll(): Promise<void> {
    const client = await pool.connect()
    let jobs: JobRow[] = []

    try {
      await client.query('BEGIN')
      const { rows } = await client.query<JobRow>(`
        SELECT * FROM worker.jobs
        WHERE status = 'pending'
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `, [BATCH_SIZE])

      jobs = rows

      if (jobs.length > 0) {
        const ids = jobs.map(j => j.id)
        await client.query(`
          UPDATE worker.jobs
          SET status = 'running', started_at = NOW()
          WHERE id = ANY($1)
        `, [ids])
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      client.release()
      throw err
    }

    client.release()

    // Dispatch in batches respecting concurrency
    const chunks = chunk(jobs, concurrency)
    for (const batch of chunks) {
      await Promise.all(batch.map(dispatch))
    }
  }

  function start(): void {
    running = true
    const tick = async (): Promise<void> => {
      if (!running) return
      try {
        await poll()
      } catch (err) {
        console.error('Executor poll error:', err)
      }
      if (running) timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    timer = setTimeout(tick, 0)
  }

  function stop(): void {
    running = false
    if (timer) clearTimeout(timer)
  }

  return { dispatch, start, stop }
}

async function markCompleted(id: string): Promise<void> {
  await pool.query(`
    UPDATE worker.jobs
    SET status = 'completed', completed_at = NOW()
    WHERE id = $1
  `, [id])
}

async function markFailed(
  id: string,
  attempts: number,
  maxAttempts: number,
  err: Error
): Promise<void> {
  const nextAttempts = attempts + 1
  const isDead = nextAttempts >= maxAttempts
  const delaySecs = backoffDelay(nextAttempts)

  await pool.query(`
    UPDATE worker.jobs
    SET
      status = $1,
      attempts = $2,
      last_error = $3,
      scheduled_at = CASE WHEN $1 = 'pending' THEN NOW() + ($4 || ' seconds')::interval ELSE scheduled_at END
    WHERE id = $5
  `, [
    isDead ? 'dead' : 'pending',
    nextAttempts,
    err.stack ?? err.message,
    delaySecs.toString(),
    id,
  ])
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: both executor tests PASS.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/worker/executor.ts src/worker/executor.test.ts
git commit -m "feat: add executor with poll loop and atomic job claiming"
```

---

### Task 6: Reaper

**Files:**
- Create: `src/worker/reaper.ts`
- Create: `src/worker/reaper.test.ts`

The reaper resets jobs that have been stuck in `running` too long back to `pending`.

**Step 1: Write the failing test**

`src/worker/reaper.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReaper } from './reaper.ts'

test('buildReaper returns start and stop functions', () => {
  const reaper = buildReaper({ defaultTimeoutMs: 60_000 })
  assert.equal(typeof reaper.start, 'function')
  assert.equal(typeof reaper.stop, 'function')
})
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `buildReaper` not found.

**Step 3: Write `src/worker/reaper.ts`**

```typescript
import { pool } from '../db/client.ts'

const REAPER_INTERVAL_MS = 60_000

interface ReaperOptions {
  defaultTimeoutMs?: number
}

interface Reaper {
  start: () => void
  stop: () => void
}

export function buildReaper(options: ReaperOptions = {}): Reaper {
  const { defaultTimeoutMs = 10 * 60 * 1000 } = options
  let running = false
  let timer: NodeJS.Timeout | null = null

  async function reap(): Promise<void> {
    const timeoutSecs = Math.floor(defaultTimeoutMs / 1000)
    const { rowCount } = await pool.query(`
      UPDATE worker.jobs
      SET status = 'pending', started_at = NULL
      WHERE status = 'running'
        AND started_at < NOW() - ($1 || ' seconds')::interval
    `, [timeoutSecs.toString()])

    if (rowCount && rowCount > 0) {
      console.log(`Reaper reset ${rowCount} stuck job(s) to pending`)
    }
  }

  function start(): void {
    running = true
    const tick = async (): Promise<void> => {
      if (!running) return
      try {
        await reap()
      } catch (err) {
        console.error('Reaper error:', err)
      }
      if (running) timer = setTimeout(tick, REAPER_INTERVAL_MS)
    }
    timer = setTimeout(tick, REAPER_INTERVAL_MS)
  }

  function stop(): void {
    running = false
    if (timer) clearTimeout(timer)
  }

  return { start, stop }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: reaper test PASSES.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/worker/reaper.ts src/worker/reaper.test.ts
git commit -m "feat: add reaper to recover stuck running jobs"
```

---

### Task 7: Scheduler

**Files:**
- Create: `src/worker/scheduler.ts`
- Create: `src/worker/scheduler.test.ts`

The scheduler loads enabled schedules from DB, registers each as a `node-cron` task, and inserts a job row each time a cron fires.

**Step 1: Write the failing test**

`src/worker/scheduler.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScheduler } from './scheduler.ts'

test('buildScheduler returns start and stop functions', () => {
  const scheduler = buildScheduler()
  assert.equal(typeof scheduler.start, 'function')
  assert.equal(typeof scheduler.stop, 'function')
})
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `buildScheduler` not found.

**Step 3: Write `src/worker/scheduler.ts`**

```typescript
import cron from 'node-cron'
import { parseExpression } from 'cron-parser'
import { pool } from '../db/client.ts'
import type { ScheduleRow } from '../types/jobs.ts'

interface Scheduler {
  start: () => Promise<void>
  stop: () => void
}

export function buildScheduler(): Scheduler {
  const tasks = new Map<string, cron.ScheduledTask>()

  async function loadAndRegister(): Promise<void> {
    const { rows } = await pool.query<ScheduleRow>(`
      SELECT * FROM worker.schedules WHERE enabled = TRUE
    `)

    for (const schedule of rows) {
      if (tasks.has(schedule.id)) continue
      registerSchedule(schedule)
    }
  }

  function registerSchedule(schedule: ScheduleRow): void {
    const task = cron.schedule(schedule.cron, async () => {
      await fireSchedule(schedule)
    })
    tasks.set(schedule.id, task)
  }

  async function fireSchedule(schedule: ScheduleRow): Promise<void> {
    const nextDate = parseExpression(schedule.cron).next().toDate()

    await pool.query(`
      INSERT INTO worker.jobs (type, payload)
      VALUES ($1, $2)
    `, [schedule.type, schedule.payload])

    await pool.query(`
      UPDATE worker.schedules
      SET last_run_at = NOW(), next_run_at = $1
      WHERE id = $2
    `, [nextDate, schedule.id])
  }

  async function start(): Promise<void> {
    await loadAndRegister()
  }

  function stop(): void {
    for (const task of tasks.values()) {
      task.stop()
    }
    tasks.clear()
  }

  return { start, stop }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: scheduler test PASSES.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/worker/scheduler.ts src/worker/scheduler.test.ts
git commit -m "feat: add scheduler with node-cron and next_run_at tracking"
```

---

### Task 8: Handler — `scrape_url`

**Files:**
- Create: `src/handlers/scrape-url.ts`
- Create: `src/handlers/scrape-url.test.ts`

Fetches a URL with the native `fetch` API. Optionally extracts text matching a CSS selector (using Node's built-in `node:vm` + a minimal regex — no DOM library needed since we use `browser_scrape` for real DOM work).

**Step 1: Write the failing test**

`src/handlers/scrape-url.test.ts`:

```typescript
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { scrapeUrlHandler } from './scrape-url.ts'

test('scrapeUrlHandler has correct type', () => {
  assert.equal(scrapeUrlHandler.type, 'scrape_url')
})

test('scrapeUrlHandler has a run function', () => {
  assert.equal(typeof scrapeUrlHandler.run, 'function')
})
```

**Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `scrapeUrlHandler` not found.

**Step 3: Write `src/handlers/scrape-url.ts`**

```typescript
import type { JobHandler } from '../types/jobs.ts'

export const scrapeUrlHandler: JobHandler<'scrape_url'> = {
  type: 'scrape_url',
  maxAttempts: 3,
  timeoutMs: 30_000,

  async run(payload) {
    const response = await fetch(payload.url)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${payload.url}`)
    }

    const html = await response.text()

    if (payload.selector) {
      // Extract text content of the first element matching the selector pattern
      // For full DOM querying use the browser_scrape handler instead
      const tagMatch = payload.selector.match(/^([a-z][a-z0-9]*)$/i)
      if (tagMatch) {
        const tag = tagMatch[1]
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
        const match = html.match(regex)
        const text = match ? match[1]?.replace(/<[^>]+>/g, '').trim() : ''
        console.log(`[scrape_url] ${payload.url} selector="${payload.selector}": ${text?.slice(0, 200)}`)
        return
      }
    }

    console.log(`[scrape_url] ${payload.url}: fetched ${html.length} bytes`)
  },
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: both scrape-url tests PASS.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/handlers/scrape-url.ts src/handlers/scrape-url.test.ts
git commit -m "feat: add scrape_url handler using native fetch"
```

---

### Task 9: Handler — `rss_fetch`

**Files:**
- Create: `src/handlers/rss-fetch.ts`
- Create: `src/handlers/rss-fetch.test.ts`

Fetches an RSS/Atom feed URL and parses entries with `fast-xml-parser`.

**Step 1: Write the failing test**

`src/handlers/rss-fetch.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rssFetchHandler } from './rss-fetch.ts'

test('rssFetchHandler has correct type', () => {
  assert.equal(rssFetchHandler.type, 'rss_fetch')
})

test('rssFetchHandler has a run function', () => {
  assert.equal(typeof rssFetchHandler.run, 'function')
})
```

**Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `rssFetchHandler` not found.

**Step 3: Write `src/handlers/rss-fetch.ts`**

```typescript
import { XMLParser } from 'fast-xml-parser'
import type { JobHandler } from '../types/jobs.ts'

interface RssItem {
  title?: string
  link?: string
  pubDate?: string
  description?: string
}

interface RssFeed {
  rss?: { channel?: { item?: RssItem | RssItem[] } }
  feed?: { entry?: RssItem | RssItem[] }
}

const parser = new XMLParser({ ignoreAttributes: false })

export const rssFetchHandler: JobHandler<'rss_fetch'> = {
  type: 'rss_fetch',
  maxAttempts: 3,
  timeoutMs: 30_000,

  async run(payload) {
    const response = await fetch(payload.feedUrl)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching feed ${payload.feedUrl}`)
    }

    const xml = await response.text()
    const parsed = parser.parse(xml) as RssFeed

    const rawItems =
      parsed.rss?.channel?.item ??
      parsed.feed?.entry ??
      []

    const items: RssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems]

    console.log(`[rss_fetch] ${payload.feedUrl}: ${items.length} items`)

    for (const item of items) {
      console.log(`  - ${item.title ?? '(no title)'} ${item.link ?? ''}`)
    }
  },
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: both rss-fetch tests PASS.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/handlers/rss-fetch.ts src/handlers/rss-fetch.test.ts
git commit -m "feat: add rss_fetch handler using fast-xml-parser"
```

---

### Task 10: Handler — `csv_ingest`

**Files:**
- Create: `src/handlers/csv-ingest.ts`
- Create: `src/handlers/csv-ingest.test.ts`

Streams a CSV file from disk using `csv-parse` so large files don't blow memory.

**Step 1: Write the failing test**

`src/handlers/csv-ingest.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvIngestHandler } from './csv-ingest.ts'

test('csvIngestHandler has correct type', () => {
  assert.equal(csvIngestHandler.type, 'csv_ingest')
})

test('csvIngestHandler has a run function', () => {
  assert.equal(typeof csvIngestHandler.run, 'function')
})
```

**Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `csvIngestHandler` not found.

**Step 3: Write `src/handlers/csv-ingest.ts`**

```typescript
import fs from 'node:fs'
import { parse } from 'csv-parse'
import type { JobHandler } from '../types/jobs.ts'

export const csvIngestHandler: JobHandler<'csv_ingest'> = {
  type: 'csv_ingest',
  maxAttempts: 3,
  timeoutMs: 5 * 60_000, // 5 minutes for large files

  async run(payload) {
    const delimiter = payload.delimiter ?? ','

    await new Promise<void>((resolve, reject) => {
      let rowCount = 0

      const stream = fs.createReadStream(payload.filePath)
        .pipe(parse({
          delimiter,
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }))

      stream.on('data', (row: Record<string, string>) => {
        rowCount++
        // TODO: replace this log with actual ingestion logic (e.g. DB insert)
        if (rowCount <= 3) {
          console.log(`[csv_ingest] row ${rowCount}:`, row)
        }
      })

      stream.on('end', () => {
        console.log(`[csv_ingest] ${payload.filePath}: processed ${rowCount} rows`)
        resolve()
      })

      stream.on('error', reject)
    })
  },
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: both csv-ingest tests PASS.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/handlers/csv-ingest.ts src/handlers/csv-ingest.test.ts
git commit -m "feat: add csv_ingest handler with streaming parser"
```

---

### Task 11: Handler — `browser_scrape`

**Files:**
- Create: `src/handlers/browser-scrape.ts`
- Create: `src/handlers/browser-scrape.test.ts`

Launches a Playwright Chromium browser per job, navigates to the URL, optionally waits for a selector, returns page content. Always tears down the browser in a `finally` block.

**Step 1: Write the failing test**

`src/handlers/browser-scrape.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserScrapeHandler } from './browser-scrape.ts'

test('browserScrapeHandler has correct type', () => {
  assert.equal(browserScrapeHandler.type, 'browser_scrape')
})

test('browserScrapeHandler has a run function', () => {
  assert.equal(typeof browserScrapeHandler.run, 'function')
})
```

**Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `browserScrapeHandler` not found.

**Step 3: Write `src/handlers/browser-scrape.ts`**

```typescript
import { chromium } from 'playwright'
import type { JobHandler } from '../types/jobs.ts'

export const browserScrapeHandler: JobHandler<'browser_scrape'> = {
  type: 'browser_scrape',
  maxAttempts: 2,
  timeoutMs: 2 * 60_000, // 2 minutes

  async run(payload) {
    const browser = await chromium.launch({ headless: true })

    try {
      const page = await browser.newPage()
      await page.goto(payload.url, { waitUntil: 'domcontentloaded' })

      if (payload.waitFor) {
        await page.waitForSelector(payload.waitFor, { timeout: 10_000 })
      }

      const content = await page.content()
      const textContent = await page.evaluate(() => document.body.innerText)

      console.log(`[browser_scrape] ${payload.url}: ${content.length} bytes HTML`)
      console.log(`[browser_scrape] text preview: ${textContent.slice(0, 300)}`)
    } finally {
      await browser.close()
    }
  },
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: both browser-scrape tests PASS.

**Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/handlers/browser-scrape.ts src/handlers/browser-scrape.test.ts
git commit -m "feat: add browser_scrape handler using Playwright Chromium"
```

---

### Task 12: Entry Point and Graceful Shutdown

**Files:**
- Modify: `src/index.ts`

Wires the scheduler, executor, and reaper together, runs the migration on startup, and handles SIGTERM/SIGINT for graceful shutdown.

**Step 1: Replace `src/index.ts`**

```typescript
import { migrate } from './db/migrate.ts'
import { buildExecutor } from './worker/executor.ts'
import { buildReaper } from './worker/reaper.ts'
import { buildScheduler } from './worker/scheduler.ts'
import { scrapeUrlHandler } from './handlers/scrape-url.ts'
import { rssFetchHandler } from './handlers/rss-fetch.ts'
import { csvIngestHandler } from './handlers/csv-ingest.ts'
import { browserScrapeHandler } from './handlers/browser-scrape.ts'
import type { HandlerRegistry } from './types/jobs.ts'

const registry: HandlerRegistry = {
  scrape_url: scrapeUrlHandler,
  rss_fetch: rssFetchHandler,
  csv_ingest: csvIngestHandler,
  browser_scrape: browserScrapeHandler,
}

async function main(): Promise<void> {
  console.log('Running migrations...')
  await migrate()

  const executor = buildExecutor(registry, {
    concurrency: 5,
    onError: (id, err) => console.error(`Job ${id} failed:`, err.message),
  })

  const reaper = buildReaper({ defaultTimeoutMs: 10 * 60 * 1000 })
  const scheduler = buildScheduler()

  await scheduler.start()
  reaper.start()
  executor.start()

  console.log('Worker started.')

  async function shutdown(signal: string): Promise<void> {
    console.log(`\nReceived ${signal}, shutting down...`)
    executor.stop()
    reaper.stop()
    scheduler.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  console.error('Worker failed to start:', err)
  process.exit(1)
})
```

**Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Smoke test locally**

Ensure `DATABASE_URL` is set, then:

```bash
npm run dev
```

Expected output:
```
Running migrations...
Worker started.
```

Worker should stay running and log any jobs it picks up.

**Step 4: Final full test run**

```bash
npm test
```

Expected: all tests across all handlers PASS.

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point with graceful shutdown and full worker wiring"
```

---

## Environment Setup

Create a `.env` file locally (add to `.gitignore`):

```
DATABASE_URL=postgres://user:password@localhost:5432/your_db
```

Load it when running:

```bash
# Install dotenv as a dev dep if desired, or export manually:
export DATABASE_URL=postgres://user:password@localhost:5432/your_db
npm run dev
```

Or add `dotenv` as a dev-only loader — but keep it out of production deps.

## Inserting Test Jobs Manually

Once running, insert a test job directly in psql:

```sql
-- One-off scrape job
INSERT INTO worker.jobs (type, payload)
VALUES ('scrape_url', '{"url": "https://example.com"}');

-- Recurring schedule (every hour)
INSERT INTO worker.schedules (type, payload, cron)
VALUES ('rss_fetch', '{"feedUrl": "https://feeds.bbci.co.uk/news/rss.xml"}', '0 * * * *');
```
