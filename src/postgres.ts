export function bindPostgresParameters(sql: string): string {
  let parameterIndex = 0;
  return sql.replace(/\?/g, () => `$${++parameterIndex}`);
}

export function selectDatabaseConnectionString(
  databaseUrl: string | undefined,
  postgresUrl: string | undefined
): string {
  const connectionString = databaseUrl || postgresUrl;
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
  if (isVercel && isSupabasePoolerHostname(url.hostname)) {
    url.searchParams.set('workaround', 'supabase-pooler.vercel');
  }
  return url.toString();
}

export function postgresConnectionDiagnostics(
  value: string,
  isVercel: boolean,
  caConfigured: boolean,
  connectionUrlSource: 'POSTGRES_URL' | 'DATABASE_URL'
): {
  vercelRuntime: boolean;
  supabasePoolerHostMatched: boolean;
  poolerWorkaroundPresent: boolean;
  connectionUrlSource: 'POSTGRES_URL' | 'DATABASE_URL';
  customCaConfigured: boolean;
} {
  const url = new URL(value);
  const { hostname } = url;
  const supabasePoolerHostMatched = isSupabasePoolerHostname(hostname);
  return {
    vercelRuntime: isVercel,
    supabasePoolerHostMatched,
    poolerWorkaroundPresent: url.searchParams
      .getAll('workaround')
      .includes('supabase-pooler.vercel'),
    connectionUrlSource,
    customCaConfigured: caConfigured
  };
}

export function postgresSslOptions(caCertificate: string | undefined): {
  rejectUnauthorized: true;
  ca?: string;
} {
  const ca = caCertificate?.replace(/\\r?\\n/g, '\n').trim();
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {})
  };
}

function isSupabasePoolerHostname(hostname: string): boolean {
  return hostname.endsWith('.pooler.supabase.com');
}
