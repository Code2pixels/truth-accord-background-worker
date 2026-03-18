import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvIngestHandler } from './csv-ingest.ts'

void test('csvIngestHandler has correct type', () => {
  assert.equal(csvIngestHandler.type, 'csv_ingest')
})

void test('csvIngestHandler has a run function', () => {
  assert.equal(typeof csvIngestHandler.run, 'function')
})
