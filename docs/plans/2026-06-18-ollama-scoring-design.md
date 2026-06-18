# Design: LLM-Based Scoring in OllamaService

**Date:** 2026-06-18  
**Status:** Approved

## Overview

Add two new LLM-powered scoring methods to `OllamaService`. These run alongside the existing heuristic `TruthfulnessService` and produce three new scores logged to console only (no DB writes). The existing heuristics are untouched.

## Scores

| Score | Scale | Meaning |
|---|---|---|
| `biasScore` | 0–100 | 0 = unbiased, 100 = heavily biased |
| `languageScore` | 0–100 | 0 = de-escalating, 50 = neutral, 100 = provoking |
| `similarArticlesScore` | 0–100 | 0 = nothing corroborates, 100 = many quality sources |

## New Methods on OllamaService

### `scoreContentAndClassify(title, summary, content)`

- **When:** After scraping (replaces the standalone `classifyTopic()` call to Ollama in the scrape worker)
- **Prompt:** Single JSON-returning prompt asking for `category`, `biasScore`, `languageScore`
- **Category** must match one of the existing CATEGORIES list (`politics`, `economics`, etc.) or `null`
- **Returns:** `{ category: string | null, biasScore: number | null, languageScore: number | null }`
- **Fallback:** Any parse failure or timeout returns nulls for scores; category null = off-topic skip

### `scoreSimilarArticles(title, similarArticles[])`

- **When:** After step 6 (similar articles found), only if `itemsToSave.length > 0`
- **Input:** Article title + array of `{ sourceDomain, similarityScore, title? }` from `itemsToSave`
- **Prompt:** Single JSON-returning prompt asking for `similarArticlesScore`
- **Returns:** `{ similarArticlesScore: number | null }`
- **Fallback:** Any parse/timeout failure returns null

## Scrape Worker Integration

The keyword classifier (`classifyTopic` from `topic-classifier.ts`) still runs first as a fast path. If it returns a category, skip the Ollama call entirely. If it returns null, call `scoreContentAndClassify()` — this single Ollama call now returns category + bias + language together.

```
Step 4 (topic filter):
  keyword fast path → category found → skip Ollama
                    → null           → scoreContentAndClassify() → { category, biasScore, languageScore }

Step 7 (after similar articles):
  scoreSimilarArticles() → { similarArticlesScore }
  console.log all three scores
```

## Error Handling

- All three score fields are nullable — any timeout or malformed JSON from Ollama yields null
- Invalid number ranges (outside 0–100) are clamped or nulled
- Ollama errors never throw; they log a warning and return nulls

## What Is Not Changing

- `TruthfulnessService` and its heuristic scores
- `topic-classifier.ts` keyword fast path
- DB schema — no new columns
- `ArticleTruthfulnessScoresRepository` — no new writes
