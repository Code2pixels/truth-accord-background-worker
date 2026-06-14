import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTopic, isAllowedTopic } from './topic-classifier.ts'

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
