# LangChain Research Service — Design

**Date:** 2026-08-17
**Status:** Approved, ready for implementation planning

## Problem

Article research today is a single TypeScript job that scrapes, classifies, matches
similar articles and scores truthfulness. Every LLM call is a hand-rolled `fetch` to
Ollama with regex JSON extraction (`src/services/ollama.service.ts`). Corroboration
sees only RSS titles and descriptions, `source_citation_quality` is a metadata
heuristic, and nothing is known about who wrote an article or who owns the outlet
that published it.

We want deeper research, all agents and tasks expressed in LangChain, and new
research into article authors and publication ownership.

## Decisions

| Decision | Choice |
|---|---|
| Where LangChain runs | Separate Python service, not LangChain.js in this repo |
| Service boundary | Python owns *all* AI research; TS keeps scraping, queueing, DB writes |
| Transport | Shared Postgres queue (`worker.jobs`), no HTTP contract |
| Entity storage | Normalized entity tables, cached with a TTL refresh |
| What findings drive | Stored and surfaced; corroboration diversity check; opaque-ownership flag. No new truthfulness sub-score columns |
| Research depth added | Full text of corroborating articles, outbound citation analysis, publication/author history |
| Migration of existing tasks | Straight port to LangChain first, verify parity, then improve |
| Heuristic fallbacks | Deleted, not ported. Ollama outage means retry/backoff, not degraded scores |

## Architecture

A new sibling repo, `truth-accord-research` (Python 3.12, LangChain + LangGraph,
FastAPI only for `/health`). It is a queue worker: it claims `worker.jobs` rows of
type `research_article` using the same `FOR UPDATE SKIP LOCKED` pattern the TS
worker uses, and writes results directly to Postgres.

| | TS worker | Python research service |
|---|---|---|
| Owns | queue polling, scraping (Playwright), paywall/Wayback, RSS ingestion, source-domain bookkeeping | every LLM and embedding call, all research agents and tools |
| Ollama | never calls it again — `OllamaService` is deleted | sole client, via `ChatOllama` / `OllamaEmbeddings` |

`OLLAMA_*` environment variables move to the Python service. The TS worker keeps
`DATABASE_URL` and its scraper configuration.

## Pipeline

The current single job splits at the article insert.

**`scrape_url` (TypeScript)** — scrape, paywall/Wayback fallback, `sources.domains`
upsert, write the body text and outbound links to `articles.content`, upsert
`articles.records` with `status='pending'` and no category, enqueue
`research_article` with `{article_id, url, search_term}`, mark itself completed.
No LLM calls, so scrape jobs finish in seconds.

**`research_article` (Python)** — a LangGraph run that classifies, researches and
finishes the article: writes `category`, truthfulness scores, similar articles,
author and ownership entities, and sets the final `status` (`approved`, `rejected`
for off-topic, `unverified` when nothing corroborates).

Consequences accepted:

- Off-topic articles are now written as `status='pending'` and flipped to
  `rejected`, where today they are never inserted. `sources.article_counts` counts
  only approved rows, but API queries that do not filter on status will see them.
- The "no similar articles → requeue → unverified" loop moves to the research job
  and uses that job's `attempts` / `max_attempts`.
- `worker.jobs.url_hash` has a *global* unique index, not per-type. `research_article`
  rows must leave `url_hash` NULL; dedupe is instead a partial unique index on
  `article_id` for pending/running rows.

## Schema

New migrations in `truth-accord-db`.

**`articles.content`** — `article_id` PK, `text`, `links JSONB`, `fetched_at`.
The TS scraper already holds the DOM, so it writes extracted text and the outbound
link list here. Python never re-fetches the original article and citation analysis
needs no LLM.

**`sources.ownership`** — cached per publication:
`domain` PK, `owner_name`, `parent_org`, `ownership_chain JSONB`, `owner_group_key`
(normalized ultimate parent; the join key for the diversity check), `country`,
`founded_year`, `funding_type`, `wikidata_qid`, `registrar`, `domain_created_at`,
`whois_privacy`, `is_opaque`, `confidence`, `evidence JSONB`, `researched_at`,
`refresh_after`.

**`authors.records`** — cached per (publication, person):
`id`, `domain`, `name`, `normalized_name`, `bio`, `role`, `beats TEXT[]`,
`profile_urls JSONB`, `wikidata_qid`, `is_person` (false for "Staff", "Editorial
Board", Reuters/AP/AFP wires), `article_count`, `first_seen_at`, `last_seen_at`,
`confidence`, `evidence JSONB`, `researched_at`, `refresh_after`; unique on
`(domain, normalized_name)`. `articles.records` gains `author_id`; `authored_by`
stays as the raw byline.

**`articles.similar_articles`** gains `owner_group_key`, `is_independent`,
`stance` (`supports` / `contradicts` / `unclear`) and `excerpt`, now that full text
of the top candidates is fetched.

**Supporting tables** — `articles.citations` (per outbound link: `url`, `domain`,
`link_type`, `is_external`), which is what `source_citation_quality` is computed
from instead of the current metadata heuristic; `research.fetch_cache`
(url → body, fetched_at, TTL) so about-pages, RDAP and Wikidata are not re-fetched
across jobs; `articles.research_runs` recording per-run node timings, model and
per-node errors.

Every `evidence` entry is `{source_type, url, snippet, retrieved_at}`, so any
surfaced claim ("owned by X") is traceable to its origin.

## Research graph

```
classify ──▶ topic gate ──(no category)──▶ mark rejected, END
                │
                ▼  (fan out in parallel)
   ┌────────────┼────────────┬──────────────┬──────────────┐
ownership     author     citations    corroboration    history
   └────────────┴────────────┴──────────────┴──────────────┘
                │
        diversity check ──▶ score ──▶ persist (one transaction)
```

Tools, all free and key-less:

- `wikidata_lookup` — P127 owned-by, P749 parent organization, P17 country,
  P571 inception, P112 founder
- `wikipedia_summary` — REST summary API
- `rdap_lookup` — registrant organization, registrar, creation date, privacy shield
- `ads_txt` — `DIRECT` seller lines are a strong ownership tell
- `fetch_page` — about / about-us / imprint / impressum / ownership / author-bio
  pages, robots-respecting, cached
- `db_publication_history` — SQL over `articles.records`

**Ownership agent.** Cache hit within TTL short-circuits. Otherwise Wikidata first
(structured, highest confidence), then site pages plus ads.txt plus RDAP, then one
LLM extraction into a Pydantic `OwnershipProfile` with per-field evidence.
`is_opaque` when there is no Wikidata entity, no imprint page, and RDAP is
privacy-shielded.

**Author agent.** Normalize the byline (strip `By `, split co-authors, detect wire
services and desk names), then the outlet author page and its JSON-LD `sameAs`,
then Wikidata person, into an `AuthorProfile`. Non-person bylines short-circuit
before any LLM call.

**Diversity check.** Map each corroborating domain to its `owner_group_key`,
collapse same-owner outlets into one, and feed *distinct owner count* — not raw
match count — into `source_citation_quality`. Five outlets under one parent count
as one.

All LLM calls use `with_structured_output(...)` against Pydantic models, replacing
the hand-rolled `extractJson` fence-stripping and clamping.

## Error handling

Research is best-effort per node: an ownership or author failure is recorded on the
run and the pipeline continues with nulls. Only DB errors or a missing article fail
the job, using the existing `[30, 120, 600]s` backoff. The stuck-job reset threshold
moves from 5 to 30 minutes for research jobs, with a heartbeat column, since these
runs legitimately take minutes.

When Ollama is unavailable the job retries and eventually goes dead. No heuristic
scores are written. The heuristic scorers in `TruthfulnessService` and the
keyword-matching path in `reference-sites-crawl` are deleted along with
`OllamaService` — roughly 500 lines — because numbers that look like scores but
carry little signal are worse than an honest, re-runnable failure.

## Testing

- pytest with recorded fixtures for every parser: RDAP, ads.txt, Wikidata mapping,
  byline normalization
- Agent tests against a fake chat model, so CI needs no Ollama
- One integration test against a throwaway Postgres with migrations applied
- Parity run over ~30 stored articles comparing old TS output against the new
  Python chain for category, bias and language, before the TS code is deleted
- TS side: a test that a scrape job enqueues a `research_article` job
