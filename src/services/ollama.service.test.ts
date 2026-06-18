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
