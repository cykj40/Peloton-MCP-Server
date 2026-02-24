import axios, { AxiosError } from 'axios';
import { PELOTON_API_URL } from '../constants.js';
import { isError, PelotonAuthError } from '../types/errors.js';
import { PelotonAuthToken } from './tokenStore.js';

/**
 * Parse JWT to extract expiration time.
 */
function parseJwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    if (typeof payload.exp === 'number') {
      return payload.exp * 1000; // Convert to milliseconds
    }
  } catch {
    // If parsing fails, use default expiry
  }
  // Default: 2 days from now
  return Date.now() + (2 * 24 * 60 * 60 * 1000);
}

/**
 * Login with password and return JWT Bearer token.
 * Peloton uses Auth0 and returns JWT tokens via the Authorization header.
 */
export async function loginWithPassword(
  username: string,
  password: string
): Promise<PelotonAuthToken> {
  try {
    const response = await axios.post<unknown>(
      `${PELOTON_API_URL}/auth/login`,
      {
        username_or_email: username,
        password,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'peloton-platform': 'web',
          'User-Agent': 'PelotonMCP/1.0',
        },
      }
    );

    // Check if response has Authorization header with Bearer token
    const authHeader = response.headers['authorization'] as string | undefined;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new PelotonAuthError(
        'Auth response missing Bearer token in Authorization header. Peloton API may have changed.'
      );
    }

    const bearerToken = authHeader.substring(7);
    const userId = typeof response.data === 'object' && response.data !== null && 'user_id' in response.data
      ? String((response.data as { user_id?: string }).user_id)
      : 'unknown';

    console.error('[Auth] Successfully authenticated via JWT Bearer token');

    return {
      access_token: bearerToken,
      token_type: 'Bearer',
      expires_at: parseJwtExpiry(bearerToken),
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
 * Refresh an expired token.
 * If a refresh_token is available, attempts token refresh.
 * Otherwise, falls back to re-login using stored credentials.
 */
export async function refreshToken(
  token: PelotonAuthToken,
  username?: string,
  password?: string
): Promise<PelotonAuthToken | null> {
  // Try refresh_token endpoint if available
  if (token.refresh_token) {
    try {
      const response = await axios.post<unknown>(
        `${PELOTON_API_URL}/auth/token/refresh`,
        {
          refresh_token: token.refresh_token,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'peloton-platform': 'web',
            'User-Agent': 'PelotonMCP/1.0',
          },
        }
      );

      // Check for Bearer token in Authorization header
      const authHeader = response.headers['authorization'] as string | undefined;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const bearerToken = authHeader.substring(7);
        console.error('[Auth] Successfully refreshed token via /auth/token/refresh');

        return {
          access_token: bearerToken,
          refresh_token: token.refresh_token,
          token_type: 'Bearer',
          expires_at: parseJwtExpiry(bearerToken),
          user_id: token.user_id,
        };
      }
    } catch (error: unknown) {
      console.error('[Auth] Token refresh failed:', isError(error) ? error.message : 'Unknown error');
    }
  }

  // Fallback: re-login using stored credentials
  if (username && password) {
    try {
      console.error('[Auth] Attempting re-login with stored credentials...');
      return await loginWithPassword(username, password);
    } catch (error: unknown) {
      console.error('[Auth] Re-login failed:', isError(error) ? error.message : 'Unknown error');
      return null;
    }
  }

  console.error('[Auth] Cannot refresh token: no refresh_token and no credentials available');
  return null;
}

