const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'DatabaseError',
  'Error',
  'TimeoutError'
]);

const SAFE_ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{1,63}|ERR_[A-Z0-9_]{1,59})$/;

export function safeDatabaseErrorMetadata(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  if (typeof error !== 'object' || error === null) {
    return { errorName: 'Error' };
  }

  const name = 'name' in error && typeof error.name === 'string' ? error.name : 'Error';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;

  return {
    errorName: SAFE_ERROR_NAMES.has(name) ? name : 'Error',
    ...(code && SAFE_ERROR_CODE.test(code) ? { errorCode: code } : {})
  };
}
