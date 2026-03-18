import fs from 'node:fs'
import path from 'node:path'
import { pool } from './client.ts'

export async function migrate(): Promise<void> {
  const client = await pool.connect()
  try {
    // Ensure the worker schema exists before creating the migrations table
    await client.query('CREATE SCHEMA IF NOT EXISTS worker')

    await client.query(`
      CREATE TABLE IF NOT EXISTS worker.migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const migrationsDir = path.join(__dirname, 'migrations')
    const files = fs.readdirSync(migrationsDir).sort()

    for (const file of files) {
      if (!file.endsWith('.sql')) continue

      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM worker.migrations WHERE name = $1',
        [file]
      )

      if (rows.length > 0) continue

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      await client.query('BEGIN')
      await client.query(sql)
      await client.query(
        'INSERT INTO worker.migrations (name) VALUES ($1)',
        [file]
      )
      await client.query('COMMIT')
      console.log(`Applied migration: ${file}`)
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
