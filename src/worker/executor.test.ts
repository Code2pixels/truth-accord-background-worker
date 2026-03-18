import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExecutor } from './executor.ts'
import type { HandlerRegistry, JobPayload } from '../types/jobs.ts'

test('executor calls the correct handler for a job type', async () => {
  const calls: string[] = []

  const registry: HandlerRegistry = {
    scrape_url: {
      type: 'scrape_url',
      run: async (payload: JobPayload['scrape_url']) => {
        calls.push(payload.url)
      },
    },
  }

  // Simulate a single dispatch (not the poll loop)
  const { dispatch } = buildExecutor(registry)

  await dispatch({
    id: 'test-id',
    type: 'scrape_url',
    payload: { url: 'https://example.com' },
    status: 'running',
    scheduled_at: new Date(),
    started_at: new Date(),
    completed_at: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    created_at: new Date(),
  })

  assert.deepEqual(calls, ['https://example.com'])
})

test('executor records error when handler throws', async () => {
  const errors: string[] = []

  const registry: HandlerRegistry = {
    scrape_url: {
      type: 'scrape_url',
      run: async () => {
        throw new Error('network timeout')
      },
    },
  }

  const { dispatch } = buildExecutor(registry, {
    onError: (id, err) => errors.push(`${id}:${err.message}`),
  })

  await dispatch({
    id: 'job-1',
    type: 'scrape_url',
    payload: { url: 'https://example.com' },
    status: 'running',
    scheduled_at: new Date(),
    started_at: new Date(),
    completed_at: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    created_at: new Date(),
  })

  assert.deepEqual(errors, ['job-1:network timeout'])
})
