import { z } from 'zod';
import { PROACTIVE_EXPIRY_BUFFER_MS } from '../constants.js';
import { deleteStoredAuthToken, getStoredAuthToken, upsertAuthToken } from '../db/queries.js';
import { CookieStoreError } from '../types/errors.js';

export { PROACTIVE_EXPIRY_BUFFER_MS };

export interface PelotonAuthToken {
  access_token: string;
  refresh_token?: string;
  session_id?: string;
  token_type: string;
  expires_at: number;
  user_id: string;
}

const PelotonAuthTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  token_type: z.string().min(1),
  expires_at: z.number(),
  user_id: z.string().min(1),
});

let runtimeToken: PelotonAuthToken | null = null;
const DEFAULT_EXPIRY_BUFFER_MS = 60 * 1000;
const PERSIST_RETRY_DELAY_MS = 500;
const PERSIST_RETRY_COUNT = 2;

let pendingPersistToken: PelotonAuthToken | null = null;

export function setRuntimeToken(token: PelotonAuthToken): void {
  runtimeToken = token;
  console.error(
    `[Token] Runtime token set for user ${token.user_id} (expires ${new Date(token.expires_at).toISOString()})`
  );
}

export function parseJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (typeof payload !== 'object' || payload === null) return null;
    const exp = (payload as Record<string, unknown>)['exp'];
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function parseJwtUserId(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return 'unknown';
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (typeof payload !== 'object' || payload === null) return 'unknown';
    const userId = (payload as Record<string, unknown>)['http://onepeloton.com/user_id'];
    return typeof userId === 'string' && userId.length > 0 ? userId : 'unknown';
  } catch {
    return 'unknown';
  }
}

function normalizeSessionId(cookieValue: string | undefined): string | undefined {
  if (!cookieValue) return undefined;
  const trimmed = cookieValue.trim();
  if (!trimmed) return undefined;

  const match = /(?:^|;\s*)peloton_session_id=([^;]+)/i.exec(trimmed);
  if (match?.[1]) {
    return match[1];
  }

  return trimmed;
}

function assertValidToken(token: PelotonAuthToken): PelotonAuthToken {
  PelotonAuthTokenSchema.parse(token);
  return token;
}

function buildEnvToken(): PelotonAuthToken | null {
  const envToken = process.env.PELOTON_BEARER_TOKEN?.trim();
  if (!envToken) {
    return null;
  }

  const expiresAt = parseJwtExpiry(envToken) ?? Date.now() + 25 * 24 * 60 * 60 * 1000;
  const sessionId = normalizeSessionId(process.env.PELOTON_SESSION_COOKIE);
  const token: PelotonAuthToken = {
    access_token: envToken,
    ...(sessionId ? { session_id: sessionId } : {}),
    token_type: 'Bearer',
    expires_at: expiresAt,
    user_id: parseJwtUserId(envToken),
  };

  return assertValidToken(token);
}

export async function loadToken(): Promise<PelotonAuthToken | null> {
  try {
    const dbToken = await getStoredAuthToken();
    if (dbToken && !isTokenExpired(dbToken)) {
      return assertValidToken(dbToken);
    }
  } catch (error: unknown) {
    console.error('[Token] Turso unavailable; falling back to in-memory token state');
  }

  await retryPendingTokenPersistence();

  if (runtimeToken && !isTokenExpired(runtimeToken)) {
    return runtimeToken;
  }
  if (runtimeToken && isTokenExpired(runtimeToken)) {
    runtimeToken = null;
  }

  const envToken = buildEnvToken();
  if (envToken && !isTokenExpired(envToken)) {
    return envToken;
  }

  return null;
}

export async function loadTokenIncludingExpired(): Promise<PelotonAuthToken | null> {
  // Turso is authoritative — must load before runtime so forced expiry triggers refresh.
  try {
    const dbToken = await getStoredAuthToken();
    if (dbToken) {
      return assertValidToken(dbToken);
    }
  } catch (error: unknown) {
    console.error('[Token] Turso unavailable; falling back to in-memory token state');
  }

  await retryPendingTokenPersistence();

  if (runtimeToken) {
    return assertValidToken(runtimeToken);
  }

  const envToken = buildEnvToken();
  if (envToken) {
    return envToken;
  }

  return null;
}

export async function saveToken(token: PelotonAuthToken): Promise<void> {
  const parsedToken = assertValidToken(token);

  try {
    await upsertAuthToken(parsedToken);
    setRuntimeToken(parsedToken);
    console.error(
      `[Token] Saved token for user ${parsedToken.user_id} (expires ${new Date(parsedToken.expires_at).toISOString()})`
    );
  } catch (error: unknown) {
    throw new CookieStoreError('Failed to save token to database', error);
  }
}

/**
 * Persist a token without ever discarding an already-rotated refresh token.
 * Returns false only after the initial attempt and two retries have all failed.
 */
export async function saveTokenWithRetry(token: PelotonAuthToken): Promise<boolean> {
  for (let attempt = 0; attempt <= PERSIST_RETRY_COUNT; attempt += 1) {
    try {
      await saveToken(token);
      if (pendingPersistToken?.access_token === token.access_token) {
        pendingPersistToken = null;
      }
      return true;
    } catch (error: unknown) {
      const isFinalAttempt = attempt === PERSIST_RETRY_COUNT;
      if (isFinalAttempt) {
        pendingPersistToken = token;
        console.error(
          '[Auth] CRITICAL: rotated token is only in memory after persistence retries failed; persistence will be retried on the next token access.'
        );
        return false;
      }

      console.error(
        `[Auth] Token persistence failed; retrying (${attempt + 1}/${PERSIST_RETRY_COUNT})...`
      );
      await new Promise((resolve) => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
    }
  }

  return false;
}

/** Retry a previously failed token persistence before serving the next token read. */
export async function retryPendingTokenPersistence(): Promise<void> {
  if (!pendingPersistToken) {
    return;
  }

  const token = pendingPersistToken;
  setRuntimeToken(token);
  await saveTokenWithRetry(token);
}

export function isTokenExpiring(token: PelotonAuthToken, bufferMs = PROACTIVE_EXPIRY_BUFFER_MS): boolean {
  return token.expires_at - Date.now() < bufferMs;
}

export function isTokenExpired(token: PelotonAuthToken): boolean {
  return isTokenExpiring(token, DEFAULT_EXPIRY_BUFFER_MS);
}

export async function clearToken(): Promise<void> {
  runtimeToken = null;
  await deleteStoredAuthToken();
}
