import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rssFetchHandler } from './rss-fetch.ts'

test('rssFetchHandler has correct type', () => {
  assert.equal(rssFetchHandler.type, 'rss_fetch')
})

test('rssFetchHandler has a run function', () => {
  assert.equal(typeof rssFetchHandler.run, 'function')
})
