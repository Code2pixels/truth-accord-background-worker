import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReaper } from './reaper.ts'

void test('buildReaper returns start and stop functions', () => {
  const reaper = buildReaper({ defaultTimeoutMs: 60_000 })
  assert.equal(typeof reaper.start, 'function')
  assert.equal(typeof reaper.stop, 'function')
})
