# Ollama-Primary Similar Article Matching

**Date:** 2026-06-21

## Problem

Similar article discovery currently uses a pure heuristic (keyword unigrams, title bigrams, named entities) to find and score candidates from RSS feeds. Ollama is only consulted after the fact to score corroboration quality of already-filtered results.

## Goal

Make Ollama the primary engine for finding similar articles and computing their match %. If Ollama is offline or fails, fall back to the existing heuristic. Also move the hardcoded similarity threshold to an env variable.

## Architecture

### `ReferenceSitesCrawlService` — new `getAllFeedItems()`

Crawls all reference RSS feeds in parallel and returns raw items with no filtering or scoring:

```ts
getAllFeedItems(): Promise<Array<{ url: string; title: string; description: string; sourceDomain: string }>>
```

The existing `getMatchingArticles()` is left intact and used as the fallback.

### `OllamaService` — new `findSimilarArticles()`

```ts
findSimilarArticles(
  originalTitle: string,
  originalMeta: string,
  originalContent: string,
  candidates: Array<{ url: string; title: string; description: string; sourceDomain: string }>,
): Promise<SimilarArticleItem[] | null>
```

- Builds a prompt with the original article and a numbered list of candidates
- Asks Ollama to return a JSON array of `{ index, similarityScore }` (0–100) for similar candidates only
- Maps scores back to full candidate objects, normalizes score to 0–1
- Returns `null` on any failure (network error, timeout, parse error) — `null` means "use fallback", not "no results"

**Prompt shape:**

```
You are a news similarity analyst. Given an original article and a list of candidates,
identify which candidates cover the same news story.

Original: "<title>" — <meta>
Content excerpt: <first 300 chars>

Candidates:
1. [sourceDomain] "<title>" — <description>
2. ...

Respond with ONLY a valid JSON array. Each element: {"index":<1-based>,"similarityScore":<0-100>}
Only include candidates with a score above 0. Empty array if none are similar.
0 = completely unrelated, 100 = same story from a different outlet.
```

### `scrape-worker.ts` — updated Step 6

```
1. getAllFeedItems() → raw candidates
2. ollama.findSimilarArticles(...) → SimilarArticleItem[] | null
3. if null → referenceSitesCrawl.getMatchingArticles() (heuristic fallback)
4. filter by SIMILAR_ARTICLE_MIN_SCORE threshold
5. ollama.scoreSimilarArticles() unchanged — runs on final filtered list
```

## Env Changes

| Old | New |
|-----|-----|
| `const MIN_SIMILARITY_TO_SAVE = 0.25` (hardcoded in worker) | `SIMILAR_ARTICLE_MIN_SCORE=0.25` (env var) |

Added to `.env.example` under "Reference sites crawl".

## Data Flow

```
RSS Feeds
    │
    ▼
getAllFeedItems() ── raw items ──► findSimilarArticles() ──► SimilarArticleItem[] ──┐
                                         │ null (failure)                            │
                                         ▼                                           │
                              getMatchingArticles() ──────────────────────────────►─┤
                                                                                     │
                                                                           filter by SIMILAR_ARTICLE_MIN_SCORE
                                                                                     │
                                                                                     ▼
                                                                         scoreSimilarArticles() (unchanged)
```

## Files Changed

- `src/services/ollama.service.ts` — add `findSimilarArticles()`
- `src/services/truthfulness/reference-sites-crawl.service.ts` — add `getAllFeedItems()`
- `src/workers/scrape-worker.ts` — update Step 6, read `SIMILAR_ARTICLE_MIN_SCORE` from env
- `.env.example` — add `SIMILAR_ARTICLE_MIN_SCORE`, update Ollama comment
