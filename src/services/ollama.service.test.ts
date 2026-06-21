import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OllamaService } from './ollama.service.ts'

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

describe('OllamaService.findSimilarArticles', () => {
  let service: OllamaService

  const candidates = [
    { url: 'https://bbc.com/1', title: 'Senate passes bill', description: 'Congress acts on bill', sourceDomain: 'bbc.com' },
    { url: 'https://fox.com/2', title: 'Sports results', description: 'Team wins game', sourceDomain: 'fox.com' },
    { url: 'https://reuters.com/3', title: 'Senate vote on legislation', description: 'Bill passes Senate vote', sourceDomain: 'reuters.com' },
  ]

  beforeEach(() => {
    service = new OllamaService()
  })

  it('returns matched candidates with normalised similarity scores', async (t) => {
    const fetchMock = makeFetchMock('[{"index":1,"similarityScore":90},{"index":3,"similarityScore":60}]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Senate bill passes', 'Congress acts', '', candidates)
    assert.ok(result !== null)
    assert.equal(result!.length, 2)
    assert.equal(result![0]!.url, 'https://bbc.com/1')
    assert.ok(Math.abs(result![0]!.similarityScore - 0.9) < 0.001)
    assert.equal(result![1]!.url, 'https://reuters.com/3')
    assert.ok(Math.abs(result![1]!.similarityScore - 0.6) < 0.001)
  })

  it('returns empty array when Ollama returns empty array', async (t) => {
    const fetchMock = makeFetchMock('[]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result!.length, 0)
  })

  it('clamps similarity scores to 0-1 range', async (t) => {
    const fetchMock = makeFetchMock('[{"index":1,"similarityScore":150}]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result![0]!.similarityScore, 1)
  })

  it('ignores out-of-range indices from Ollama', async (t) => {
    const fetchMock = makeFetchMock('[{"index":0,"similarityScore":80},{"index":99,"similarityScore":70}]')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result!.length, 0)
  })

  it('returns null on fetch failure', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(async () => { throw new Error('timeout') }))

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns null on non-ok response', async (t) => {
    const fetchMock = makeFetchMock('', false)
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns null on malformed JSON', async (t) => {
    const fetchMock = makeFetchMock('not json')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('returns null on JSON that is not an array', async (t) => {
    const fetchMock = makeFetchMock('{"index":1,"similarityScore":80}')
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.equal(result, null)
  })

  it('parses similarity scores from a markdown-fenced JSON array response', async (t) => {
    const fencedResponse = '```json\n[{"index":1,"similarityScore":75}]\n```'
    const fetchMock = makeFetchMock(fencedResponse)
    t.mock.method(globalThis, 'fetch', fetchMock)

    const result = await service.findSimilarArticles('Title', 'Meta', '', candidates)
    assert.ok(result !== null)
    assert.equal(result!.length, 1)
    assert.equal(result![0]!.url, 'https://bbc.com/1')
    assert.ok(Math.abs(result![0]!.similarityScore - 0.75) < 0.001)
  })

  it('returns empty array without calling fetch when candidates list is empty', async (t) => {
    t.mock.method(globalThis, 'fetch', mock.fn(() => { throw new Error('fetch should not be called') }))

    const result = await service.findSimilarArticles('Title', 'Meta', '', [])
    assert.ok(result !== null)
    assert.equal(result!.length, 0)
  })
})
