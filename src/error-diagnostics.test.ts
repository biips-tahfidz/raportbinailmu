import assert from 'node:assert/strict';
import test from 'node:test';
import { safeDatabaseErrorMetadata } from './error-diagnostics.js';

test('database diagnostics retain only safe error name and SQLSTATE/network code', () => {
  const error = Object.assign(new Error('DATABASE_URL contains credentials'), {
    name: 'DatabaseError',
    code: 'ECONNREFUSED',
    detail: 'student record'
  });

  assert.deepEqual(safeDatabaseErrorMetadata(error), {
    errorName: 'DatabaseError',
    errorCode: 'ECONNREFUSED'
  });
});

test('database diagnostics omit unrecognized codes and error names', () => {
  const error = {
    name: 'secret-user-password',
    code: 'postgres://user:password@database',
    message: 'sensitive message',
    detail: 'sensitive detail'
  };

  assert.deepEqual(safeDatabaseErrorMetadata(error), { errorName: 'Error' });
});

test('database diagnostics retain PostgreSQL SQLSTATE values', () => {
  assert.deepEqual(safeDatabaseErrorMetadata({ code: '28P01' }), {
    errorName: 'Error',
    errorCode: '28P01'
  });
});
