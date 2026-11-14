import 'dotenv/config';
import { Pool, types, type PoolClient } from 'pg';
import { safeDatabaseErrorMetadata } from './error-diagnostics.js';
import {
  bindPostgresParameters,
  postgresConnectionDiagnostics,
  postgresSslOptions,
  preparePostgresConnectionString,
  selectDatabaseConnectionString
} from './postgres.js';

types.setTypeParser(1082, (value) => value);

const postgresUrl = process.env.POSTGRES_URL;
const databaseUrl = process.env.DATABASE_URL;
const connectionUrlSource = postgresUrl ? 'POSTGRES_URL' : 'DATABASE_URL';
const connectionString = selectDatabaseConnectionString(postgresUrl, databaseUrl);
const isVercel = process.env.VERCEL === '1';
const supabaseSslCa = process.env.SUPABASE_SSL_CA;
const preparedConnectionString = preparePostgresConnectionString(connectionString, isVercel);
export const databaseConnectionMetadata = postgresConnectionDiagnostics(
  preparedConnectionString,
  isVercel,
  Boolean(supabaseSslCa?.trim()),
  connectionUrlSource
);
const poolMax = Number(process.env.DB_POOL_MAX ?? 3);
if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 10) {
  throw new Error('DB_POOL_MAX harus berupa bilangan bulat antara 1 dan 10.');
}

export const db = new Pool({
  connectionString: preparedConnectionString,
  ssl: postgresSslOptions(supabaseSslCa),
  max: poolMax,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000
});
db.on('error', (error) => {
  console.error(
    'Koneksi Postgres idle terputus; permintaan berikutnya akan mencoba koneksi baru.',
    { ...databaseConnectionMetadata, ...safeDatabaseErrorMetadata(error) }
  );
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
