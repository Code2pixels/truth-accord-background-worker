import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserScrapeHandler } from './browser-scrape.ts'

void test('browserScrapeHandler has correct type', () => {
  assert.equal(browserScrapeHandler.type, 'browser_scrape')
})

void test('browserScrapeHandler has a run function', () => {
  assert.equal(typeof browserScrapeHandler.run, 'function')
})
