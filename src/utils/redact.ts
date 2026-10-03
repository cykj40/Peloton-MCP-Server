import { createHash } from 'node:crypto';

const ID_PREFIX_LENGTH = 8;
const HASH_LENGTH = 8;

/** Truncate an identifier (e.g. Peloton user_id) for logging: first 8 chars + "...". */
export function redactId(id: string): string {
  if (id === 'unknown') {
    return id;
  }
  return `${id.slice(0, ID_PREFIX_LENGTH)}...`;
}

/** Short, non-reversible fingerprint for values that must not be logged raw (e.g. DB URLs). */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HASH_LENGTH);
}

/** Redact user ids embedded in Peloton API paths such as /api/user/<id>/workouts. */
export function redactUserIdInPath(value: string): string {
  return value.replace(/(\/api\/user\/)[^/?#\s]+/g, '$1<redacted>');
}

/** Hide user ids while retaining workout limit/page suffixes for cache diagnostics. */
export function redactCacheKey(key: string): string {
  if (/^workouts_.+_\d+_\d+$/.test(key)) {
    return key.replace(/^workouts_.+_(\d+)_(\d+)$/, 'workouts_<redacted>_$1_$2');
  }
  return key
    .replace(/^workouts_.+_(\d+)$/, 'workouts_<redacted>_$1')
    .replace(/^profile_.+$/, 'profile_<redacted>');
}
