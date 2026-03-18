import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScheduler } from './scheduler.ts'

test('buildScheduler returns start and stop functions', () => {
  const scheduler = buildScheduler()
  assert.equal(typeof scheduler.start, 'function')
  assert.equal(typeof scheduler.stop, 'function')
})
