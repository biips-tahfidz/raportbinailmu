import 'dotenv/config';
import { Pool, types, type PoolClient } from 'pg';
import { bindPostgresParameters, connectionStringWithoutTlsOverrides } from './postgres.js';

types.setTypeParser(1082, (value) => value);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL wajib diatur untuk menghubungkan Supabase Postgres.');
}
const poolMax = Number(process.env.DB_POOL_MAX ?? 3);
if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 10) {
  throw new Error('DB_POOL_MAX harus berupa bilangan bulat antara 1 dan 10.');
}

export const db = new Pool({
  connectionString: connectionStringWithoutTlsOverrides(connectionString),
  ssl: { rejectUnauthorized: true },
  max: poolMax,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000
});
db.on('error', () => {
  console.error('Koneksi Postgres idle terputus; permintaan berikutnya akan mencoba koneksi baru.');
});

export async function many<T = Record<string, unknown>>(
  sql: string,
  ...parameters: unknown[]
): Promise<T[]> {
  const result = await db.query(bindPostgresParameters(sql), parameters);
  return result.rows as T[];
}

export async function one<T = Record<string, unknown>>(
  sql: string,
  ...parameters: unknown[]
): Promise<T | undefined> {
  const result = await db.query(bindPostgresParameters(sql), parameters);
  return result.rows[0] as T | undefined;
}

export async function execute(sql: string, ...parameters: unknown[]): Promise<number> {
  const result = await db.query(bindPostgresParameters(sql), parameters);
  return result.rowCount ?? 0;
}

export async function transaction<T>(
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
