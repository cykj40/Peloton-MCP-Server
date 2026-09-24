import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTH_CODE_TTL_MS = 60_000;
const MAX_PENDING_CODES = 100;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export type PendingAuthorization = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
};

export type AuthCodeStore = {
  issue: (grant: Omit<PendingAuthorization, 'expiresAt'>) => string | undefined;
  consume: (code: string) => PendingAuthorization | undefined;
};

export function createAuthCodeStore(ttlMs: number = AUTH_CODE_TTL_MS): AuthCodeStore {
  const pending = new Map<string, PendingAuthorization>();

  const sweep = (now: number): void => {
    for (const [code, grant] of pending) {
      if (grant.expiresAt <= now) pending.delete(code);
    }
  };

  return {
    issue(grant) {
      const now = Date.now();
      sweep(now);
      // /authorize is unauthenticated, so cap growth from request floods.
      if (pending.size >= MAX_PENDING_CODES) return undefined;
      const code = randomBytes(32).toString('base64url');
      pending.set(code, { ...grant, expiresAt: now + ttlMs });
      return code;
    },
    consume(code) {
      const grant = pending.get(code);
      pending.delete(code);
      if (!grant || grant.expiresAt <= Date.now()) return undefined;
      return grant;
    },
  };
}

export function isValidCodeChallenge(challenge: string): boolean {
  return PKCE_CHALLENGE_PATTERN.test(challenge);
}

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!PKCE_VERIFIER_PATTERN.test(codeVerifier)) return false;
  const expected = Buffer.from(createHash('sha256').update(codeVerifier).digest('base64url'));
  const actual = Buffer.from(codeChallenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseAllowedRedirectUris(raw: string | undefined): Set<string> {
  const allowed = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const uri = entry.trim();
    if (!uri) continue;
    try {
      new URL(uri);
      allowed.add(uri);
    } catch {
      console.error('[OAuth] Ignoring unparseable ALLOWED_REDIRECT_URIS entry');
    }
  }
  return allowed;
}
