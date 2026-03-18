import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKOFF_SECONDS, backoffDelay } from './jobs.ts'

void test('backoffDelay returns 30s for first attempt', () => {
  assert.equal(backoffDelay(1), 30)
})

void test('backoffDelay returns 120s for second attempt', () => {
  assert.equal(backoffDelay(2), 120)
})

void test('backoffDelay returns 600s for third and beyond', () => {
  assert.equal(backoffDelay(3), 600)
  assert.equal(backoffDelay(99), 600)
})

void test('BACKOFF_SECONDS has correct values', () => {
  assert.deepEqual(BACKOFF_SECONDS, [30, 120, 600])
})
