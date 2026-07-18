import axios, { AxiosError } from 'axios';
import { z } from 'zod';
import {
  PELOTON_API_URL,
  PELOTON_AUTH_CLIENT_ID,
  PELOTON_AUTH_LOGIN_PATH,
  PELOTON_AUTH_TOKEN_URL,
  PELOTON_TOKEN_EXPIRES_IN_SECONDS,
} from '../constants.js';
import { isError, PelotonAuthError } from '../types/errors.js';
import {
  isTokenExpiring,
  loadTokenIncludingExpired,
  parseJwtExpiry,
  parseJwtUserId,
  PelotonAuthToken,
  saveToken,
  saveTokenWithRetry,
  setRuntimeToken,
} from './tokenStore.js';

let authMutationTail: Promise<void> = Promise.resolve();
let refreshInFlight: Promise<PelotonAuthToken> | null = null;

function serializeAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = authMutationTail;
  let release: () => void;
  authMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous.then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
}

/**
 * Runs a manual bootstrap write after any active refresh. This is process-local;
 * rotating tokens are therefore supported with exactly one running machine.
 */
export function serializeManualTokenOverride<T>(operation: () => Promise<T>): Promise<T> {
  return serializeAuthMutation(operation);
}

const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.number().positive(),
});

function resolveAuthClientId(): string {
  const override = process.env.PELOTON_AUTH_CLIENT_ID?.trim();
  return override && override.length > 0 ? override : PELOTON_AUTH_CLIENT_ID;
}

/**
 * Parse JWT to extract expiration time.
 */
function parseJwtExpiryFromAccessToken(token: string): number {
  return parseJwtExpiry(token) ?? Date.now() + PELOTON_TOKEN_EXPIRES_IN_SECONDS * 1000;
}

function extractSessionId(setCookieHeader: string | string[] | undefined): string | undefined {
  if (!setCookieHeader) return undefined;

  const headerValues = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const headerValue of headerValues) {
    const match = /(?:^|;\s*)peloton_session_id=([^;]+)/i.exec(headerValue);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function buildTokenFromOAuthResponse(
  parsed: z.infer<typeof OAuthTokenResponseSchema>,
  previous: PelotonAuthToken
): PelotonAuthToken {
  const rotatedRefresh = parsed.refresh_token ?? previous.refresh_token;
  if (!rotatedRefresh) {
    throw new PelotonAuthError('OAuth refresh response missing refresh_token');
  }

  return {
    access_token: parsed.access_token,
    refresh_token: rotatedRefresh,
    ...(previous.session_id ? { session_id: previous.session_id } : {}),
    token_type: parsed.token_type ?? 'Bearer',
    expires_at: Date.now() + parsed.expires_in * 1000,
    user_id: parseJwtUserId(parsed.access_token) !== 'unknown'
      ? parseJwtUserId(parsed.access_token)
      : previous.user_id,
  };
}

/**
 * Bootstrap or update stored credentials from browser-extracted OAuth tokens.
 */
export function buildBootstrapToken(
  accessToken: string,
  refreshToken?: string,
  existing?: PelotonAuthToken | null
): PelotonAuthToken {
  const jwtExp = parseJwtExpiry(accessToken);
  return {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(existing?.session_id ? { session_id: existing.session_id } : {}),
    token_type: 'Bearer',
    expires_at: jwtExp ?? Date.now() + PELOTON_TOKEN_EXPIRES_IN_SECONDS * 1000,
    user_id: parseJwtUserId(accessToken),
  };
}

/**
 * Exchange a refresh token at Auth0 (peloton-to-garmin flow). Refresh tokens rotate.
 */
export async function refreshOAuthToken(token: PelotonAuthToken): Promise<PelotonAuthToken> {
  if (!token.refresh_token) {
    throw new PelotonAuthError('No refresh_token available for OAuth refresh');
  }

  const clientId = resolveAuthClientId();

  try {
    const response = await axios.post<unknown>(
      PELOTON_AUTH_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: token.refresh_token,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        validateStatus: () => true,
      }
    );

    if (response.status >= 400) {
      throw new PelotonAuthError(
        `OAuth token refresh failed (${response.status})`,
        new Error(typeof response.data === 'string' ? response.data : JSON.stringify(response.data))
      );
    }

    const parsed = OAuthTokenResponseSchema.parse(response.data);
    console.error('[Auth] Successfully refreshed access token via Auth0');
    return buildTokenFromOAuthResponse(parsed, token);
  } catch (error: unknown) {
    if (error instanceof PelotonAuthError) {
      throw error;
    }

    const axiosError = error instanceof AxiosError ? error : null;
    if (axiosError?.response) {
      throw new PelotonAuthError(
        `OAuth token refresh failed (${axiosError.response.status})`,
        error
      );
    }

    throw new PelotonAuthError(
      `OAuth token refresh failed: ${isError(error) ? error.message : 'Unknown error'}`,
      error
    );
  }
}

/**
 * Refresh via Auth0, preferring the Turso token immediately before the request.
 * Concurrent callers share one request; this only coordinates a single process.
 */
export async function refreshOAuthTokenAndPersist(token: PelotonAuthToken): Promise<PelotonAuthToken> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = serializeAuthMutation(async () => {
    const storedToken = await loadTokenIncludingExpired();
    const tokenToRefresh = storedToken ?? token;

    if (
      storedToken &&
      storedToken.refresh_token !== token.refresh_token &&
      !isTokenExpiring(storedToken)
    ) {
      console.error('[Auth] Adopted newer Turso token; skipping stale refresh request');
      setRuntimeToken(storedToken);
      return storedToken;
    }

    const refreshed = await refreshOAuthToken(tokenToRefresh);
    setRuntimeToken(refreshed);
    await saveTokenWithRetry(refreshed);
    return refreshed;
  });

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Login with password and return JWT Bearer token.
 * Uses Cloudflare bypass path when still accepted (see peloton-to-garmin issue #795).
 */
export async function loginWithPassword(
  username: string,
  password: string
): Promise<PelotonAuthToken> {
  try {
    const response = await axios.post<unknown>(
      PELOTON_AUTH_LOGIN_PATH,
      {
        username_or_email: username,
        password,
      },
      {
        baseURL: PELOTON_API_URL,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'peloton-platform': 'web',
          'User-Agent': 'PelotonMCP/1.0',
        },
      }
    );

    const authHeader = response.headers['authorization'] as string | undefined;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new PelotonAuthError(
        'Auth response missing Bearer token in Authorization header. Peloton API may have changed.'
      );
    }

    const bearerToken = authHeader.substring(7);
    const sessionId = extractSessionId(response.headers['set-cookie'] as string | string[] | undefined);
    const userId = typeof response.data === 'object' && response.data !== null && 'user_id' in response.data
      ? String((response.data as { user_id?: string }).user_id)
      : 'unknown';

    console.error('[Auth] Successfully authenticated via JWT Bearer token');

    return {
      access_token: bearerToken,
      ...(sessionId ? { session_id: sessionId } : {}),
      token_type: 'Bearer',
      expires_at: parseJwtExpiryFromAccessToken(bearerToken),
      user_id: userId,
    };
  } catch (error: unknown) {
    const axiosError = error instanceof AxiosError ? error : null;
    if (axiosError?.response) {
      throw new PelotonAuthError(
        `Auth login failed (${axiosError.response.status}): ${
          typeof axiosError.response.data === 'string'
            ? axiosError.response.data
            : JSON.stringify(axiosError.response.data)
        }`,
        error
      );
    }

    throw new PelotonAuthError(
      `Failed to login: ${isError(error) ? error.message : 'Unknown error'}`,
      error
    );
  }
}

/**
 * Refresh an expired or expiring token: OAuth refresh first, then password login fallback.
 */
export async function refreshToken(
  token: PelotonAuthToken,
  username?: string,
  password?: string
): Promise<PelotonAuthToken | null> {
  if (token.refresh_token) {
    try {
      return await refreshOAuthTokenAndPersist(token);
    } catch (error: unknown) {
      console.error('[Auth] OAuth refresh failed:', isError(error) ? error.message : 'Unknown error');
    }
  }

  if (username && password) {
    try {
      console.error('[Auth] Attempting auto-login with stored credentials...');
      const loggedIn = await loginWithPassword(username, password);
      await saveToken(loggedIn);
      return loggedIn;
    } catch (error: unknown) {
      console.error('[Auth] Auto-login failed:', isError(error) ? error.message : 'Unknown error');
    }
  }

  console.error('[Auth] Cannot refresh token: no refresh_token and auto-login unavailable');
  return null;
}
