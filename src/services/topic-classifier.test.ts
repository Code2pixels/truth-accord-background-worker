import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTopic, feedCategoryVerdict, isAllowedTopic } from './topic-classifier.ts'

describe('classifyTopic', () => {
  it('returns category from RSS alias when provided', () => {
    assert.equal(classifyTopic('some text', ['Markets']), 'economics')
  })

  it('alias matching is case-insensitive', () => {
    assert.equal(classifyTopic('some text', ['POLITICS']), 'politics')
  })

  it('falls back to keyword scan when alias has no match', () => {
    assert.equal(classifyTopic('the senate passed a new bill today', ['unknown-category']), 'politics')
  })

  it('falls back to keyword scan when no rssCategories provided', () => {
    assert.equal(classifyTopic('nasa discovers new exoplanet'), 'science')
  })

  it('returns null for off-topic text', () => {
    assert.equal(classifyTopic('buy cheap sneakers on sale'), null)
  })

  it('returns null for empty string', () => {
    assert.equal(classifyTopic(''), null)
  })

  it('prefers first matching category from aliases array', () => {
    const result = classifyTopic('text', ['unknown', 'tech'])
    assert.equal(result, 'technology')
  })
})

describe('isAllowedTopic', () => {
  it('returns true for allowed topic', () => {
    assert.equal(isAllowedTopic('the supreme court ruled today'), true)
  })

  it('returns false for off-topic text', () => {
    assert.equal(isAllowedTopic('best pizza recipes'), false)
  })
})

describe('feedCategoryVerdict', () => {
  it('accepts a category the research service researches', () => {
    assert.equal(feedCategoryVerdict(['Politics']), 'target')
    assert.equal(feedCategoryVerdict(['world']), 'target')
  })

  it('rejects a category nobody researches', () => {
    assert.equal(feedCategoryVerdict(['Science']), 'off-target')
    assert.equal(feedCategoryVerdict(['health']), 'off-target')
    assert.equal(feedCategoryVerdict(['markets']), 'off-target')
  })

  it('keeps an item filed under both a target and a non-target category', () => {
    assert.equal(feedCategoryVerdict(['technology', 'politics']), 'target')
  })

  it('is unknown when the feed says nothing', () => {
    assert.equal(feedCategoryVerdict(), 'unknown')
    assert.equal(feedCategoryVerdict([]), 'unknown')
  })

  it('is unknown for the junk values most feeds actually publish', () => {
    // Measured across 3043 live items: "news", "top", "storytype:standard" and
    // similar make up the majority of category values.
    assert.equal(feedCategoryVerdict(['news']), 'unknown')
    assert.equal(feedCategoryVerdict(['top']), 'unknown')
    assert.equal(feedCategoryVerdict(['structure:apple-news-free']), 'unknown')
    assert.equal(feedCategoryVerdict(['donald trump']), 'unknown')
  })

  it('never rejects on an unrecognised value alone', () => {
    assert.equal(feedCategoryVerdict(['news', 'top', 'gear']), 'unknown')
  })
})
