import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  bindPostgresParameters,
  preparePostgresConnectionString,
  selectDatabaseConnectionString
} from './postgres.js';

test('parameter binding converts positional placeholders in order', () => {
  assert.equal(
    bindPostgresParameters('SELECT * FROM students WHERE class_id = ? AND name = ?'),
    'SELECT * FROM students WHERE class_id = $1 AND name = $2'
  );
  assert.equal(bindPostgresParameters('SELECT CURRENT_TIMESTAMP'), 'SELECT CURRENT_TIMESTAMP');
});

test('database URLs cannot override enforced TLS configuration', () => {
  const result = new URL(
    preparePostgresConnectionString(
      'postgresql://user:secret@db.example.test/postgres?sslmode=disable&sslrootcert=unsafe.crt&application_name=rapor',
      false
    )
  );
  assert.equal(result.searchParams.has('sslmode'), false);
  assert.equal(result.searchParams.has('sslrootcert'), false);
  assert.equal(result.searchParams.get('application_name'), 'rapor');
  assert.throws(
    () => preparePostgresConnectionString('https://db.example.test', true),
    /DATABASE_URL/
  );
});

test('Vercel adds the Supabase pooler workaround exactly once and only for pooler hosts', () => {
  const poolerUrl =
    'postgresql://user:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
  const configured = new URL(
    preparePostgresConnectionString(`${poolerUrl}?workaround=old&workaround=duplicate`, true)
  );
  assert.deepEqual(configured.searchParams.getAll('workaround'), ['supabase-pooler.vercel']);
  assert.equal(
    preparePostgresConnectionString(configured.toString(), true),
    configured.toString()
  );

  const local = new URL(preparePostgresConnectionString(poolerUrl, false));
  assert.equal(local.searchParams.has('workaround'), false);

  const nonPooler = new URL(
    preparePostgresConnectionString('postgresql://user:secret@db.example.supabase.co/postgres', true)
  );
  assert.equal(nonPooler.searchParams.has('workaround'), false);

  const suffixLookalike = new URL(
    preparePostgresConnectionString(
      'postgresql://user:secret@aws-0.pooler.supabase.com.example.test/postgres',
      true
    )
  );
  assert.equal(suffixLookalike.searchParams.has('workaround'), false);
});

test('native POSTGRES_URL takes precedence, with DATABASE_URL as fallback', () => {
  assert.equal(
    selectDatabaseConnectionString('postgresql://native.example.test/db', 'postgresql://fallback.example.test/db'),
    'postgresql://native.example.test/db'
  );
  assert.equal(
    selectDatabaseConnectionString(undefined, 'postgresql://fallback.example.test/db'),
    'postgresql://fallback.example.test/db'
  );
  assert.throws(() => selectDatabaseConnectionString(undefined, undefined), /POSTGRES_URL.*DATABASE_URL/);
});

test('Supabase schema migration is repeatable, private from API roles, and has no student seed data', async () => {
  const migration = await readFile(
    new URL('../db/migrations/001_initial_schema.sql', import.meta.url),
    'utf8'
  );
  const database = new PGlite();
  try {
    await database.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    await database.exec(migration);
    await database.exec(migration);

    const settings = await database.query<{ count: number }>(
      'SELECT COUNT(*)::integer AS count FROM public.school_settings'
    );
    const students = await database.query<{ count: number }>(
      'SELECT COUNT(*)::integer AS count FROM public.students'
    );
    const access = await database.query<{ anon_usage: boolean; anon_select: boolean }>(
      `SELECT has_schema_privilege('anon', 'public', 'USAGE') AS anon_usage,
              has_table_privilege('anon', 'public.students', 'SELECT') AS anon_select`
    );
    const rls = await database.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class
       WHERE oid = 'public.students'::regclass`
    );

    assert.equal(settings.rows[0]?.count, 1);
    assert.equal(students.rows[0]?.count, 0);
    assert.deepEqual(access.rows[0], { anon_usage: false, anon_select: false });
    assert.equal(rls.rows[0]?.relrowsecurity, true);
    await assert.rejects(
      database.query(
        `INSERT INTO public.users (name, username, password_hash, role)
         VALUES ('Test', 'invalid-role', 'hash', 'student')`
      ),
      { code: '23514' }
    );
  } finally {
    await database.close();
  }
});
