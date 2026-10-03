import { describe, expect, it } from 'vitest';
import { redactCacheKey } from '../utils/redact.js';

describe('redactCacheKey', () => {
  it.each(['0123456789abcdef0123456789abcdef', 'user_with_underscores', 'user_100_2'])('hides the entire user id in a paginated workout key: %s', userId => {
    const redacted = redactCacheKey(`workouts_${userId}_100_24`);
    expect(redacted).toBe('workouts_<redacted>_100_24');
    expect(redacted).not.toContain(userId);
  });

  it('also hides user ids in legacy workout and profile keys', () => {
    expect(redactCacheKey('workouts_private_user_100')).toBe('workouts_<redacted>_100');
    expect(redactCacheKey('profile_private_user')).toBe('profile_<redacted>');
  });

  it('leaves unrelated cache keys unchanged', () => {
    expect(redactCacheKey('ride_muscles_123')).toBe('ride_muscles_123');
  });
});
