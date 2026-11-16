import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDeletionAllowed,
  assertProtectedEditAllowed,
  type DeletableEntity,
  type ProtectedEdit
} from './admin-edit-policy.js';

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

test('every deletable master-data type blocks deletion when referenced', () => {
  const entities: DeletableEntity[] = [
    'class',
    'student',
    'subject',
    'objective',
    'term',
    'user',
    'score-rule'
  ];

  for (const entity of entities) {
    assert.throws(() => assertDeletionAllowed(entity, true), /masih digunakan dan tidak dapat dihapus/);
    assert.doesNotThrow(() => assertDeletionAllowed(entity, false));
  }
});
