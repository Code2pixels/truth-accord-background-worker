import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReferenceSitesCrawlService } from './reference-sites-crawl.service.ts'
import type { SimilarArticleItem } from './reference-sites-crawl.service.ts'

interface PrivateMethods {
  extractBigrams(title: string): Set<string>
  extractNamedEntities(content: string): Set<string>
  getMatchesInFeed(
    feedUrl: string,
    sourceDomain: string,
    keywords: Set<string>,
    titleBigrams: Set<string>,
    namedEntities: Set<string>,
  ): Promise<SimilarArticleItem[]>
}

// We test private methods via casting
const svc = new ReferenceSitesCrawlService(null as never)
const priv = svc as unknown as PrivateMethods

const extractBigrams = (s: string): Set<string> => priv.extractBigrams(s)
const extractNamedEntities = (s: string): Set<string> => priv.extractNamedEntities(s)

describe('extractBigrams', () => {
  it('returns bigrams from a normal title', () => {
    const result = extractBigrams('Election fraud claims rejected by court')
    assert.ok(result.has('election fraud'), 'expected "election fraud"')
    assert.ok(result.has('fraud claims'), 'expected "fraud claims"')
    assert.ok(result.has('claims rejected'), 'expected "claims rejected"')
  })

  it('filters out bigrams containing stop words', () => {
    const result = extractBigrams('Trump signs the new bill')
    assert.ok(!result.has('signs the'), 'should not include "signs the"')
    assert.ok(!result.has('the new'), 'should not include "the new"')
  })

  it('returns empty set for short title', () => {
    assert.equal(extractBigrams('Trade').size, 0)
  })

  it('is case-insensitive', () => {
    const result = extractBigrams('NATO Summit begins')
    assert.ok(result.has('nato summit'))
  })
})

describe('extractNamedEntities', () => {
  it('extracts a single proper noun', () => {
    const result = extractNamedEntities('The president signed the bill. Donald Trump spoke today.')
    assert.ok(result.has('Donald Trump'), 'expected "Donald Trump"')
  })

  it('extracts multi-word entity', () => {
    const result = extractNamedEntities('Some text. Supreme Court ruled against the law.')
    assert.ok(result.has('Supreme Court'), 'expected "Supreme Court"')
  })

  it('does not extract first word of sentence (sentence-start false positive)', () => {
    const result = extractNamedEntities('Policy makers met today. Trade talks resumed.')
    assert.ok(!result.has('Policy'), 'sentence-start word should be excluded')
    assert.ok(!result.has('Trade'), 'sentence-start word should be excluded')
  })

  it('returns empty set for lowercase content', () => {
    const result = extractNamedEntities('the quick brown fox jumps over the lazy dog')
    assert.equal(result.size, 0)
  })

  it('handles empty string', () => {
    assert.equal(extractNamedEntities('').size, 0)
  })
})

describe('getMatchesInFeed scoring', () => {
  const getMatchesInFeed = priv.getMatchesInFeed.bind(svc)

  it('rejects candidate with no named entity match', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      text: async () => `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Economy policy debate heats up</title>
            <description>Policy makers discuss economic reforms</description>
            <link>https://example.com/article-1</link>
          </item>
        </channel></rss>`,
    }))

    const keywords = new Set(['economy', 'policy', 'debate', 'federal', 'reserve'])
    const titleBigrams = new Set(['economy policy', 'policy debate'])
    const namedEntities = new Set(['Federal Reserve Board'])

    const result = await getMatchesInFeed(
      'https://feeds.example.com/rss',
      'example.com',
      keywords,
      titleBigrams,
      namedEntities,
    )

    assert.equal(result.length, 0, 'should reject candidate missing named entity')
    mock.restoreAll()
  })

  it('accepts candidate with both bigram and entity match', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      text: async () => `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Federal Reserve raises interest rates again</title>
            <description>Federal Reserve Board signals more rate hikes ahead in economy policy debate</description>
            <link>https://example.com/article-2</link>
          </item>
        </channel></rss>`,
    }))

    const keywords = new Set(['economy', 'policy', 'debate', 'federal', 'reserve'])
    const titleBigrams = new Set(['economy policy', 'policy debate'])
    const namedEntities = new Set(['Federal Reserve Board'])

    const result = await getMatchesInFeed(
      'https://feeds.example.com/rss',
      'example.com',
      keywords,
      titleBigrams,
      namedEntities,
    )

    assert.equal(result.length, 1, 'should accept candidate with bigram + entity match')
    assert.ok(result[0]!.similarityScore > 0, 'score should be positive')
    mock.restoreAll()
  })
})
