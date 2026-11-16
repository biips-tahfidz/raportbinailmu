import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProtectedEditAllowed, type ProtectedEdit } from './admin-edit-policy.js';

const protectedEdits: ProtectedEdit[] = [
  'class-grade',
  'class-name',
  'student-code',
  'student-name',
  'student-class',
  'subject-name',
  'subject-grade',
  'objective',
  'term'
];

test('master-data relationship changes are blocked when dependent records exist', () => {
  for (const edit of protectedEdits) {
    assert.throws(() => assertProtectedEditAllowed(edit, true), Error);
    assert.doesNotThrow(() => assertProtectedEditAllowed(edit, false));
  }
});
