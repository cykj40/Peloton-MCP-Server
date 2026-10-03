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

/** Redact the user id segment of cache keys like workouts_<id>_<limit> and profile_<id>. */
export function redactCacheKey(key: string): string {
  return key.replace(/^(workouts_|profile_)([^_]+)/, (_match, prefix: string, id: string) => `${prefix}${redactId(id)}`);
}
