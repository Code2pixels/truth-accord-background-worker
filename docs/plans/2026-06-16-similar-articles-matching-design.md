# Similar Articles Matching Improvement

**Date:** 2026-06-16  
**Goal:** Replace weak unigram keyword overlap with named entity + bigram matching so similar articles reflect the same specific story, not just the same broad topic.

---

## Problem

The current algorithm extracts individual words from the source article's title + meta description and checks how many appear in each RSS feed candidate. A score of `matchedWords / totalWords >= 0.2` passes. This produces false positives: two articles sharing words like "economy", "policy", or "trump" match even when they cover entirely different events.

---

## Solution: Named Entities + Bigrams + Raised Threshold

### Keyword Extraction

`extractKeywords` is replaced by a richer extraction that takes `title`, `meta`, and full `content` and returns three sets:

- **`titleBigrams`** — 2-word phrases from the title only (e.g. `"election fraud"`, `"nato summit"`)
- **`namedEntities`** — proper noun runs from full content body. Heuristic: split into sentences, skip each sentence's first word, collect runs of 1–3 consecutive capitalized tokens (≥3 chars, not in stop words). Examples: `"Donald Trump"`, `"Gaza Strip"`, `"Supreme Court"`
- **`keywords`** — existing unigram set from title + meta (kept for score denominator)

### Matching Requirements (all three must pass)

1. **At least 1 title bigram** must appear verbatim in the candidate's title or description
2. **At least 1 named entity** from the source must appear in the candidate's title or description
3. **At least `MIN_KEYWORD_MATCH` (2) unigrams** must match (existing check, kept)

Any candidate failing condition 1 or 2 is rejected outright.

### Scoring Formula

```
score = (unigram_matches / totalKeywords)  * 0.4
      + (bigram_matches  / totalBigrams)   * 0.35
      + (entity_matches  / totalEntities)  * 0.25
```

Falls back gracefully: if `totalBigrams == 0` the bigram weight transfers to unigrams; if `totalEntities == 0` the entity weight transfers to unigrams.

### Threshold

`MIN_SIMILARITY_TO_SAVE` raised from `0.2` → `0.4`.

---

## Call Site Change

`getMatchingArticles(title, meta)` → `getMatchingArticles(title, meta, content)`

In `scrape-worker.ts` step 6, pass `scraped.content ?? ''` as the third argument.

---

## Files Changed

| File | Change |
|------|--------|
| `src/services/truthfulness/reference-sites-crawl.service.ts` | Replace extraction + matching logic, new scoring formula |
| `src/workers/scrape-worker.ts` | Pass `scraped.content` to `getMatchingArticles` |
