import { Pool } from 'pg'

// DATABASE_URL is required at runtime; the pool will fail on first use if not set
export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
})

pool.on('error', (err: Error) => {
  console.error('Unexpected pg pool error', err)
})
