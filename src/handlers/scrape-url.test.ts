import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { scrapeUrlHandler } from './scrape-url.ts'

test('scrapeUrlHandler has correct type', () => {
  assert.equal(scrapeUrlHandler.type, 'scrape_url')
})

test('scrapeUrlHandler has a run function', () => {
  assert.equal(typeof scrapeUrlHandler.run, 'function')
})
