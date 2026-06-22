# Embedding Pre-Filter for Similar Article Matching (C-hybrid)

**Date:** 2026-06-21

## Problem

`findSimilarArticles()` sends all RSS candidates (up to 200) in a single large prompt to gemma. This overflows the model's context window, causing truncated/garbage output. Raising `num_ctx` and using JSON mode mitigated the crash, but sending hundreds of candidates in one prompt is fundamentally fragile, and the keyword heuristic fallback matches poorly.

## Goal

Use semantic embeddings to rank candidates and send only the top-K to gemma for final scoring. This fixes context overflow and improves match quality, with the keyword heuristic remaining only as a last resort.

## Architecture — Three-Tier Fallback

All orchestration lives inside `OllamaService.findSimilarArticles()`. The scrape worker's Step 6 is unchanged: it calls `findSimilarArticles()` and drops to the keyword heuristic only when it returns `null`.

```
200 raw candidates
   │  embed original + all candidates  (Ollama /api/embed, one batched call)
   ▼
cosine-rank → take top-K (~20)
   │  gemma scores "same story?" on top-K  (small prompt, /api/generate)
   ▼
final matches with %
```

- **Tier 1 (normal):** embeddings rank → gemma refines top-K into match %.
- **Tier 2 (generate fails after a successful embed):** return top-K scored by cosine similarity directly — still semantic, returns a non-null result.
- **Tier 3 (embed endpoint down → `findSimilarArticles` returns `null`):** worker falls back to the existing keyword heuristic.

## Components (all in `src/services/ollama.service.ts`)

### `embed(inputs: string[]): Promise<number[][] | null>`
- POST `${OLLAMA_BASE_URL}/api/embed` with `{ model: OLLAMA_EMBED_MODEL, input: inputs }`
- Returns the `embeddings` array (`number[][]`), or `null` on non-ok / timeout / malformed response
- One batched call embeds `[originalText, ...candidateTexts]` together

### `cosineSimilarity(a: number[], b: number[]): number`
- Module-level pure function
- Returns 0 for zero-magnitude vectors (guard against divide-by-zero)

### `findSimilarArticles(originalTitle, originalMeta, originalContent, candidates)` (reworked)
1. `candidates.length === 0` → return `[]`
2. Cap candidates at `OLLAMA_MAX_CANDIDATES`
3. Build texts: original = `title + meta + content excerpt`; each candidate = `title + description`
4. `embed([originalText, ...candidateTexts])`; if `null` → return `null` (Tier 3)
5. Split first vector (original) from the rest (candidates); cosine-rank candidates
6. Take top-`OLLAMA_PREFILTER_TOPK`
7. Send top-K to the existing generate prompt (JSON mode); map returned scores back to candidate URLs
8. If generate returns `null` → return top-K with cosine-derived scores (Tier 2)
9. Clamp all scores to [0, 1]

## New Env Vars

| Var | Default | Purpose |
|-----|---------|---------|
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | embedding model pulled on the Ollama instance |
| `OLLAMA_PREFILTER_TOPK` | `20` | how many top-ranked candidates gemma scores |

`OLLAMA_MAX_CANDIDATES` (existing, 200) stays as the cap on how many candidates are embedded.

## Error Handling
- Embed failure → `null` → keyword heuristic (unchanged worker behavior)
- Generate failure after successful embed → cosine-scored top-K (Tier 2), not null
- All scores clamped to [0, 1]

## Testing (TDD)
- `cosineSimilarity`: identical = 1, orthogonal = 0, zero-vector = 0
- `embed`: parses `embeddings`; null on non-ok / timeout / malformed
- `findSimilarArticles`:
  - ranks and sends only top-K to generate; maps generate scores to correct URLs
  - Tier 2: generate fails → returns cosine-scored top-K (non-null)
  - Tier 3: embed fails → returns null
  - respects `OLLAMA_PREFILTER_TOPK`
  - empty candidates → `[]`
- Test fetch mock routes by URL (`/api/embed` vs `/api/generate`)

## Files Changed
- `src/services/ollama.service.ts` — add `embed()`, `cosineSimilarity()`, rework `findSimilarArticles()`
- `src/services/ollama.service.test.ts` — embed + cosine + tiered findSimilarArticles tests; URL-routing fetch mock
- `.env.example` — add `OLLAMA_EMBED_MODEL`, `OLLAMA_PREFILTER_TOPK`
