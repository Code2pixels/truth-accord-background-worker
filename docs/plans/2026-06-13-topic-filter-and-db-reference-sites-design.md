# Topic Filter & DB-Backed Reference Sites — Design

**Date:** 2026-06-13

## Problem

The worker ingests and scores articles from any topic. We want to restrict to Political, Science, and Educational content only. Additionally, the `REFERENCE_SITES` constant is a maintenance burden — trust scores and feed URLs for reference sources should live in the database so admins can manage them from the frontend.

## Goals

1. Topic allowlist filter: only Political, Science, Educational articles are ingested and stored.
2. Similar-article crawl returns only on-topic results matching the parent article's context.
3. `REFERENCE_SITES` const deleted; reference site data (trust score, feed URL) driven from `sources.records`.
4. Trust score editable per-source from the admin manage-sources UI.

## Approach

Keyword-based topic classifier (no extra dependencies, free to run). Applied at two points in the pipeline — cheap pre-filter at RSS ingestion, accurate post-scrape filter using full content. Same classifier applied inside the similar-articles crawl to filter results.

---

## Components

### DB migration (`truth-accord-db`)

- Add `trust_score NUMERIC(3,2) DEFAULT NULL` to `sources.records`.
- `NULL` = unrated / not used as a reference site.
- Second migration seeds trust scores via `UPDATE` for domains that overlap with the current `REFERENCE_SITES` const values.

### Topic classifier (`truth-accord-background-worker`)

**`src/config/topic-filter.config.ts`**
Keyword lists for three topics:
- `political` — congress, senate, parliament, election, government, policy, legislation, vote, president, white house, minister, treaty, sanctions, diplomat, campaign, ballot, political, partisan, judiciary, supreme court, federal, nato, geopolitics, foreign affairs, state department
- `science` — research, study, scientist, climate, species, genome, vaccine, nasa, space, physics, chemistry, biology, astronomy, ecology, evolution, experiment, laboratory, fossil, pandemic, virus, scientific, discovery, evidence, peer review, environment, carbon, emissions, renewable, nuclear, quantum
- `education` — school, university, college, student, teacher, professor, curriculum, academic, education, graduation, scholarship, tuition, literacy, learning, classroom, campus, faculty, enrollment, degree, dissertation, training

**`src/services/topic-classifier.ts`**
```
isAllowedTopic(text: string): boolean
```
Lowercases input, checks whether any keyword from any topic list appears as a substring. Returns `true` on first match.

### RSS feed worker filter

`FeedItem` interface gains `title` and `description` (already parsed by `fast-xml-parser`, just untyped). Before `workerJobsRepo.createIfNew(...)`, call `isAllowedTopic(title + ' ' + description)`. Skip queuing if false.

### Scrape worker filter

After scraping (step 1), before upserting the article (step 4), call `isAllowedTopic(title + meta + content)`. If false, mark the job `completed` with a log line and return early — no DB writes for the article, scores, or similar articles.

### Similar-articles crawl filter

Inside `ReferenceSitesCrawlService.getMatchesInFeed(...)`, after keyword matching and before pushing to results, call `isAllowedTopic(itemTitle + ' ' + itemDescription)`. Off-topic feed items are dropped regardless of keyword similarity score.

### Replace `REFERENCE_SITES` const

**New: `src/repositories/reference-sites.repository.ts`**
```
findAll(): Promise<{ domain: string; trustScore: number; feedUrl: string }[]>
```
Queries `sources.records WHERE trust_score IS NOT NULL AND rss_url IS NOT NULL`. Extracts domain from the `url` column (strip scheme, strip `www.`).

**`ReferenceSitesCrawlService`**
- Constructor receives `ReferenceSitesRepository`.
- Lazy-loads reference site list into a private field on first call.
- Exposes `getTrustScore(domain: string): number | null` for use by `TruthfulnessService`.

**`TruthfulnessService.scoreFactualAccuracy()`**
- Currently calls the static `getReferenceTrustScore(domain)`.
- Replace with `this.referenceSitesCrawl.getTrustScore(domain)` (already has this dep in constructor).
- Method becomes `async`.

**Delete:**
- `src/config/reference.config.ts`
- `src/services/truthfulness/reference-sites.const.ts`

### API changes (`truth-accord-api`)

- `ISource` interface: add `trust_score: number | null`
- `UpdateSourceDto`: add `@IsOptional() @IsNumber() @Min(0) @Max(1) trust_score?: number | null`
- `sources.repository.ts`: include `trust_score` in all `SELECT` lists and in the dynamic `UPDATE` builder
- No new endpoint — `PATCH /sources/:id` handles it

### Frontend changes (`truth-accord-frontend`)

- `types/index.ts` `ISource`: add `trust_score: number | null`
- `lib/apiClient.ts` `updateSource` body: add `trust_score?: number | null`
- `app/manage/page.tsx` Sources tab:
  - Add `trust_score` to `editForm` state (`number | string`)
  - Table: new "Trust" column showing the score (e.g. `0.92`) or `—`
  - Edit row: number input for trust score (`step="0.01"`, `min="0"`, `max="1"`)
  - Save payload: include `trust_score` (parse to float or `null` if empty)

---

## Data flow

```
RSS feed → FeedItem (title+desc) → isAllowedTopic? → queue job
                                        ↓ no → skip

Job queue → scrape → isAllowedTopic(title+meta+content)? → upsert article
                              ↓ no → mark completed, no insert

            → getMatchingArticles → per feed item: isAllowedTopic? → include in results
                                                        ↓ no → drop

            → getTrustScore(domain) [from DB via ReferenceSitesCrawlService]
            → scoreFactualAccuracy uses live trust score
```

---

## Out of scope

- LLM-based classification
- Per-source topic tagging in DB
- Backfill / re-scoring existing articles
