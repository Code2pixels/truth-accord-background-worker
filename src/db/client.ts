import { Pool } from 'pg'

const url = process.env['DATABASE_URL'] ?? ''
const isLocal = url.includes('localhost') || url.includes('127.0.0.1')

export const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
})

pool.on('error', (err: Error) => {
  console.error('Unexpected pg pool error', err)
})

export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(sql, params)
  return result.rows as T[]
}

export async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const result = await pool.query(sql, params)
  return (result.rows[0] as T) ?? null
}
