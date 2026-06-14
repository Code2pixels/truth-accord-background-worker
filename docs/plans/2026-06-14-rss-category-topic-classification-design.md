# RSS Category-Based Topic Classification Design

**Date:** 2026-06-14
**Status:** Approved

## Problem

The current topic filter (`isAllowedTopic`) only covers 3 categories (political, science, education) with a small keyword list. This causes many valid articles to be silently dropped. Additionally, articles have no stored category, making future category-based browsing impossible.

## Goals

1. Expand topic coverage to a broader set of normalized categories
2. Use RSS `<category>` tags as the primary classification signal (more accurate than keyword guessing)
3. Store the resolved category on each article for future filtering/display

## Normalized Category Taxonomy

| Name | Covers |
|---|---|
| `politics` | government, elections, policy, diplomacy |
| `economics` | markets, finance, trade, business |
| `science` | research, space, physics, biology, climate |
| `health` | medicine, public health, pharma, mental health |
| `technology` | software, AI, cybersecurity, hardware |
| `education` | schools, universities, curriculum, student policy |
| `law` | courts, legislation, justice, regulation |
| `environment` | climate action, conservation, pollution |
| `world` | international affairs, conflict, foreign policy |
| `society` | culture, race, religion, demographics, labor |

## Architecture

### Category Resolution (Two-Stage)

**Stage 1 — RSS worker (filter gate)**
- Parse `item.category` from feed items (RSS 2.0: plain string or array; Atom: `<category term="...">`)
- Run through `CATEGORY_ALIASES` map (publisher-specific strings → normalized category)
- If match found → allow through
- If no category or no alias match → fall back to keyword scan on `title + description`
- If still no match → skip queuing (off-topic)

**Stage 2 — Scrape worker (authoritative classification)**
- Re-classify from full scraped content: `title + metaDescription + body`
- Uses same `classifyTopic()` function — full text makes this more accurate than RSS metadata
- Resolved category stored on the article record

### New `classifyTopic(text: string): string | null`

Replaces `isAllowedTopic(): boolean`. Returns the normalized category name of the first matching category, or `null` if off-topic. `isAllowedTopic` becomes a thin wrapper:

```ts
export function isAllowedTopic(text: string): boolean {
  return classifyTopic(text) !== null
}
```

For RSS items, a second overload accepts an optional list of raw category strings to check aliases first:

```ts
export function classifyTopic(text: string, rssCategories?: string[]): string | null
```

## Config Changes

### `topic-filter.config.ts`

- Expand `TOPIC_KEYWORDS` to all 10 categories with ~30 keywords each
- Add `CATEGORY_ALIASES: Record<string, string>` — lowercase publisher category strings mapped to normalized names:

```ts
export const CATEGORY_ALIASES: Record<string, string> = {
  'us': 'politics',
  'politics': 'politics',
  'us-politics': 'politics',
  'markets': 'economics',
  'business': 'economics',
  'finance': 'economics',
  'health': 'health',
  'science': 'science',
  'technology': 'technology',
  'tech': 'technology',
  // ... etc
}
```

## Data Model Change

### DB Migration (`truth-accord-db`)

```sql
-- migrate:up
ALTER TABLE articles.records ADD COLUMN category VARCHAR(50);

-- migrate:down
ALTER TABLE articles.records DROP COLUMN category;
```

### `CreateArticleInput` (types.ts)

Add `category: string | null` field.

### `ArticlesRepository.upsert`

Include `category` in the INSERT and ON CONFLICT UPDATE.

## Files Changed

| File | Change |
|---|---|
| `src/config/topic-filter.config.ts` | Expand keywords, add `CATEGORY_ALIASES` |
| `src/services/topic-classifier.ts` | `classifyTopic()` returning category name; keep `isAllowedTopic` wrapper |
| `src/workers/rss-feed.worker.ts` | Parse `item.category`, pass raw categories to `classifyTopic` |
| `src/workers/scrape-worker.ts` | Use `classifyTopic`, pass category to article upsert |
| `src/types.ts` | Add `category` to `CreateArticleInput` |
| `src/repositories/articles.repository.ts` | Include `category` in upsert SQL |
| `truth-accord-db/db/migrations/` | Add `category` column migration |
