import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CODE_TTL_MS, createAuthCodeStore, parseAllowedRedirectUris } from './oauthCodes.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createAuthCodeStore', () => {
  it('evicts expired codes at capacity while retaining unexpired codes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const store = createAuthCodeStore();
    const grant = {
      clientId: 'test-client',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'a'.repeat(43),
    };

    const firstBatch = Array.from({ length: 50 }, () => store.issue(grant));
    vi.setSystemTime(AUTH_CODE_TTL_MS / 2);
    const secondBatch = Array.from({ length: 50 }, () => store.issue(grant));
    for (const code of [...firstBatch, ...secondBatch]) expect(code).toEqual(expect.any(String));
    // The store holds MAX_PENDING_CODES (100) live grants and rejects overflow.
    expect(store.issue(grant)).toBeUndefined();

    vi.setSystemTime(AUTH_CODE_TTL_MS);
    // Only the first batch has expired. Issuance must sweep it before checking capacity.
    const replacements = Array.from({ length: 50 }, () => store.issue(grant));
    for (const code of replacements) expect(code).toEqual(expect.any(String));
    expect(store.issue(grant)).toBeUndefined();

    for (const code of firstBatch) expect(store.consume(code!)).toBeUndefined();
    for (const code of [...secondBatch, ...replacements]) {
      expect(store.consume(code!)).toMatchObject(grant);
    }
  });
});

describe('parseAllowedRedirectUris', () => {
  it('drops malformed entries without throwing or discarding valid callbacks', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = 'https://claude.ai/api/mcp/auth_callback';
    const second = 'https://claude.com/api/mcp/auth_callback';
    let parsed: Set<string> | undefined;

    expect(() => {
      parsed = parseAllowedRedirectUris(`${first}, not a valid URL, ${second}`);
    }).not.toThrow();
    expect(parsed).toEqual(new Set([first, second]));
  });
});
