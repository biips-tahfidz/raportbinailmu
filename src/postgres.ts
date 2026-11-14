export function bindPostgresParameters(sql: string): string {
  let parameterIndex = 0;
  return sql.replace(/\?/g, () => `$${++parameterIndex}`);
}

export function selectDatabaseConnectionString(
  postgresUrl: string | undefined,
  databaseUrl: string | undefined
): string {
  const connectionString = postgresUrl || databaseUrl;
  if (!connectionString) {
    throw new Error('POSTGRES_URL atau DATABASE_URL wajib diatur untuk menghubungkan Supabase Postgres.');
  }
  return connectionString;
}

export function preparePostgresConnectionString(value: string, isVercel: boolean): string {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('POSTGRES_URL atau DATABASE_URL harus berupa URL PostgreSQL yang valid.');
  }
  url.searchParams.delete('ssl');
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  if (isVercel && url.hostname.endsWith('.pooler.supabase.com')) {
    url.searchParams.set('workaround', 'supabase-pooler.vercel');
  }
  return url.toString();
}
