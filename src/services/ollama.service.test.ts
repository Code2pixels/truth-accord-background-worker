import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OllamaService, cosineSimilarity, positiveIntEnv } from './ollama.service.ts'

function makeFetchMock(responseText: string, ok = true) {
  return mock.fn(async () => ({
    ok,
    json: async () => ({ response: responseText }),
  }))
}

describe('OllamaService.scoreContentAndClassify', () => {
  let service: OllamaService

  beforeEach(() => {
    service = new OllamaService()
  })

  it('returns parsed scores and category on valid JSON response', async (t) => {
    const fetchMock = makeFetchMock('{"category":"politics","biasScore":70,"languageScore":80}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Senate passes bill', 'Congress acted', '')
    assert.equal(result.category, 'politics')
    assert.equal(result.biasScore, 70)
    assert.equal(result.languageScore, 80)
  })

  it('returns null category for unrecognized category value', async (t) => {
    const fetchMock = makeFetchMock('{"category":"sports","biasScore":30,"languageScore":20}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.equal(result.category, null)
    assert.equal(result.biasScore, 30)
  })

  it('clamps scores outside 0-100 range', async (t) => {
    const fetchMock = makeFetchMock('{"category":"science","biasScore":150,"languageScore":-10}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.equal(result.biasScore, 100)
    assert.equal(result.languageScore, 0)
  })

  it('returns all nulls on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.deepEqual(result, { category: null, biasScore: null, languageScore: null })
  })

  it('returns all nulls on non-ok response', async (t) => {
    const fetchMock = makeFetchMock('', false)
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.deepEqual(result, { category: null, biasScore: null, languageScore: null })
  })

  it('returns all nulls on malformed JSON', async (t) => {
    const fetchMock = makeFetchMock('not json at all')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreContentAndClassify('Title', 'Summary', '')
    assert.deepEqual(result, { category: null, biasScore: null, languageScore: null })
  })
})

describe('OllamaService.scoreSimilarArticles', () => {
  let service: OllamaService

  beforeEach(() => {
    service = new OllamaService()
  })

  it('returns parsed score on valid response', async (t) => {
    const fetchMock = makeFetchMock('{"similarArticlesScore":85}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreSimilarArticles('Senate bill passes', [
      { sourceDomain: 'bbc.com', similarityScore: 0.9, title: 'Senate votes on bill' },
      { sourceDomain: 'reuters.com', similarityScore: 0.75, title: null },
    ])
    assert.equal(result.similarArticlesScore, 85)
  })

  it('clamps score above 100', async (t) => {
    const fetchMock = makeFetchMock('{"similarArticlesScore":120}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreSimilarArticles('Title', [{ sourceDomain: 'ap.org', similarityScore: 0.8, title: null }])
    assert.equal(result.similarArticlesScore, 100)
  })

  it('returns null on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))

    const result = await service.scoreSimilarArticles('Title', [])
    assert.deepEqual(result, { similarArticlesScore: null })
  })

  it('returns null on malformed JSON', async (t) => {
    const fetchMock = makeFetchMock('garbage')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.scoreSimilarArticles('Title', [])
    assert.deepEqual(result, { similarArticlesScore: null })
  })
})

function makeRoutedMock(routes: { embed?: unknown; embedOk?: boolean; generate?: string; generateOk?: boolean }) {
  return mock.fn(async (url: string) => {
    if (url.includes('/api/embed')) {
      return { ok: routes.embedOk ?? true, json: async () => routes.embed ?? { embeddings: [] } }
    }
    return { ok: routes.generateOk ?? true, json: async () => ({ response: routes.generate ?? '[]' }) }
  })
}

describe('OllamaService.findSimilarArticles', () => {
  let service: OllamaService

  const candidates = [
    { url: 'https://bbc.com/1', title: 'Senate passes bill', description: 'Congress acts on bill', sourceDomain: 'bbc.com' },
    { url: 'https://fox.com/2', title: 'Sports results', description: 'Team wins game', sourceDomain: 'fox.com' },
    { url: 'https://reuters.com/3', title: 'Senate vote on legislation', description: 'Bill passes Senate vote', sourceDomain: 'reuters.com' },
  ]

  // original, c1 (bbc), c2 (fox), c3 (reuters). Ranked by cosine to [1,0]: c1 (1.0), c3 (~0.99), c2 (0.0)
  const embedBody = { embeddings: [[1, 0], [1, 0], [0, 1], [0.9, 0.1]] }

  beforeEach(() => {
    service = new OllamaService()
  })

  it('Tier 1: embeddings rank then gemma scores top-K', async (t) => {
    // ranked order: c1 (bbc), c3 (reuters), c2 (fox). generate index 1=c1, index 2=c3
    const fetchMock = makeRoutedMock({ embed: embedBody, generate: '[{"index":1,"similarityScore":90},{"index":2,"similarityScore":60}]' })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    const result = await service.findSimilarArticles('Senate bill passes', 'Congress acts', '', candidates)
    assert.ok(result !== null)
    assert.equal(result.length, 2)
    assert.equal(result[0]!.url, 'https://bbc.com/1')
    assert.ok(Math.abs(result[0]!.similarityScore - 0.9) < 0.001)
    assert.equal(result[1]!.url, 'https://reuters.com/3')
    assert.ok(Math.abs(result[1]!.similarityScore - 0.6) < 0.001)
  })

  it('returns empty array without calling fetch when candidates list is empty', async (t) => {
    const fetchMock = mock.fn(() => { throw new Error('fetch should not be called') })
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', [])
    assert.ok(result !== null)
    assert.equal(result.length, 0)
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  it('clamps similarity scores to 0-1 range', async (t) => {
    const fetchMock = makeRoutedMock({ embed: embedBody, generate: '[{"index":1,"similarityScore":150}]' })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result[0]!.similarityScore, 1)
  })

  it('ignores out-of-range indices from gemma generate', async (t) => {
    const fetchMock = makeRoutedMock({ embed: embedBody, generate: '[{"index":0,"similarityScore":80},{"index":99,"similarityScore":70}]' })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result.length, 0)
  })

  it('Tier 2: non-array generate response falls back to cosine scores', async (t) => {
    const fetchMock = makeRoutedMock({ embed: embedBody, generate: '{"index":1}' })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result.length, 3)
    // top item is c1 (bbc) with cosine ~1.0
    assert.equal(result[0]!.url, 'https://bbc.com/1')
    assert.ok(Math.abs(result[0]!.similarityScore - 1) < 0.001)
  })

  it('Tier 2: generate HTTP failure falls back to cosine scores', async (t) => {
    const fetchMock = makeRoutedMock({ embed: embedBody, generateOk: false, generate: 'gateway timeout' })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result.length, 3)
    // top item is c1 (bbc) with cosine ~1.0
    assert.equal(result[0]!.url, 'https://bbc.com/1')
    assert.ok(Math.abs(result[0]!.similarityScore - 1) < 0.001)
  })

  it('Tier 3: embed failure returns null for heuristic fallback', async (t) => {
    const fetchMock = makeRoutedMock({ embedOk: false })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns null when embed count does not match input count', async (t) => {
    const fetchMock = makeRoutedMock({ embed: { embeddings: [[1, 0], [1, 0]] } })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('respects OLLAMA_PREFILTER_TOPK', async (t) => {
    const prev = process.env['OLLAMA_PREFILTER_TOPK']
    process.env['OLLAMA_PREFILTER_TOPK'] = '1'
    try {
      const fetchMock = makeRoutedMock({ embed: embedBody, generate: '[]' })
      t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

      await service.findSimilarArticles('Title', 'Meta', '', candidates)

      const genCall = fetchMock.mock.calls.find((c) => ((c.arguments as unknown[])[0] as string).includes('/api/generate'))
      assert.ok(genCall)
      const body = JSON.parse(((genCall.arguments as unknown[])[1] as { body: string }).body) as { prompt: string }
      assert.ok(body.prompt.includes('1. ['))
      assert.ok(!body.prompt.includes('2. ['))
    } finally {
      if (prev === undefined) delete process.env['OLLAMA_PREFILTER_TOPK']
      else process.env['OLLAMA_PREFILTER_TOPK'] = prev
    }
  })

  it('requests JSON mode on the generate call without forcing a custom num_ctx', async (t) => {
    const fetchMock = makeRoutedMock({ embed: embedBody, generate: '[]' })
    t.mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch)

    await service.findSimilarArticles('Title', 'Meta', '', candidates)

    const genCall = fetchMock.mock.calls.find((c) => ((c.arguments as unknown[])[0] as string).includes('/api/generate'))
    assert.ok(genCall)
    const body = JSON.parse(((genCall.arguments as unknown[])[1] as { body: string }).body) as { format?: string; options?: { num_ctx?: number } }
    assert.equal(body.format, 'json')
    // No num_ctx override: keeps gemma at its default context so it isn't reloaded
    // between the small classify/score calls and this one (a reload caused timeouts).
    assert.equal(body.options?.num_ctx, undefined)
  })
})

function makeEmbedMock(body: unknown, ok = true) {
  return mock.fn(async () => ({ ok, json: async () => body }))
}

describe('OllamaService.embed', () => {
  let service: OllamaService
  beforeEach(() => { service = new OllamaService() })

  it('returns the embeddings array on success', async (t) => {
    t.mock.method(globalThis, 'fetch', makeEmbedMock({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }))
    const result = await service.embed(['a', 'b'])
    assert.deepEqual(result, [[0.1, 0.2], [0.3, 0.4]])
  })
  it('returns empty array without calling fetch for empty input', async (t) => {
    const m = makeEmbedMock({ embeddings: [] })
    t.mock.method(globalThis, 'fetch', m)
    const result = await service.embed([])
    assert.deepEqual(result, [])
    assert.equal(m.mock.calls.length, 0)
  })
  it('returns null on non-ok response', async (t) => {
    t.mock.method(globalThis, 'fetch', makeEmbedMock({}, false))
    assert.equal(await service.embed(['a']), null)
  })
  it('returns null on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))
    assert.equal(await service.embed(['a']), null)
  })
  it('returns null when embeddings field is missing', async (t) => {
    t.mock.method(globalThis, 'fetch', makeEmbedMock({ notEmbeddings: true }))
    assert.equal(await service.embed(['a']), null)
  })
})

describe('positiveIntEnv', () => {
  const KEY = 'OLLAMA_TEST_POS_INT'
  function withEnv(value: string | undefined, fn: () => void) {
    const prev = process.env[KEY]
    if (value === undefined) delete process.env[KEY]
    else process.env[KEY] = value
    try { fn() } finally {
      if (prev === undefined) delete process.env[KEY]
      else process.env[KEY] = prev
    }
  }

  it('returns the fallback when the env var is unset', () => {
    withEnv(undefined, () => assert.equal(positiveIntEnv(KEY, 20), 20))
  })
  it('returns the fallback for non-numeric input', () => {
    withEnv('abc', () => assert.equal(positiveIntEnv(KEY, 20), 20))
  })
  it('returns the fallback for zero', () => {
    withEnv('0', () => assert.equal(positiveIntEnv(KEY, 20), 20))
  })
  it('returns the fallback for negative input', () => {
    withEnv('-5', () => assert.equal(positiveIntEnv(KEY, 20), 20))
  })
  it('floors and returns valid positive input', () => {
    withEnv('7.9', () => assert.equal(positiveIntEnv(KEY, 20), 7))
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
  })
  it('returns 0 for orthogonal vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9)
  })
  it('returns 0 when either vector is all zeros (no divide-by-zero)', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0)
  })
  it('handles differing lengths by using the shorter length', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 5], [1, 0]) - 1) < 1e-9)
  })
  it('returns 0 for malformed (non-numeric) vector entries instead of NaN', () => {
    assert.equal(cosineSimilarity([1, NaN], [1, 2]), 0)
  })
})
