import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { CookieStoreError, isError } from '../types/errors.js';

export interface PelotonAuthToken {
  access_token: string;       // JWT Bearer token
  refresh_token?: string;     // For refreshing sessions
  token_type: string;         // "Bearer"
  expires_at: number;         // Unix timestamp (ms)
  user_id: string;
}

const TOKEN_DIR = path.join(process.env.APPDATA || os.homedir(), '.peloton');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token.json');

const PelotonAuthTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  token_type: z.string(),
  expires_at: z.number(),
  user_id: z.string(),
});

function isPelotonAuthToken(value: unknown): value is PelotonAuthToken {
  return PelotonAuthTokenSchema.safeParse(value).success;
}

/**
 * Parse JWT expiry from a token string (without a library).
 */
function parseJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    if (typeof payload !== 'object' || payload === null) return null;
    const exp = (payload as Record<string, unknown>)['exp'];
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Parse user_id from a JWT token string.
 */
function parseJwtUserId(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return 'unknown';
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    if (typeof payload !== 'object' || payload === null) return 'unknown';
    const p = payload as Record<string, unknown>;
    // Peloton stores user_id in a custom claim
    const userId = p['http://onepeloton.com/user_id'] ?? p['sub'];
    return typeof userId === 'string' ? userId : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Load stored JWT token.
 * Checks PELOTON_BEARER_TOKEN env var first (for Fly.io), then falls back to file.
 * Returns null if no valid token found.
 */
export async function loadToken(): Promise<PelotonAuthToken | null> {
  // 1. Check env var first (Fly.io / production override)
  const envToken = process.env.PELOTON_BEARER_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    const token = envToken.trim();
    const expiresAt = parseJwtExpiry(token) ?? (Date.now() + 2 * 24 * 60 * 60 * 1000);
    const userId = parseJwtUserId(token);
    const authToken: PelotonAuthToken = {
      access_token: token,
      token_type: 'Bearer',
      expires_at: expiresAt,
      user_id: userId,
    };

    if (!isTokenExpired(authToken)) {
      const minutesRemaining = Math.floor((expiresAt - Date.now()) / (60 * 1000));
      console.error(`[Token] Using PELOTON_BEARER_TOKEN from env (expires in ${minutesRemaining} minutes)`);
      return authToken;
    }

    console.error('[Token] PELOTON_BEARER_TOKEN in env is expired, falling back to file');
  }

  // 2. Fall back to file-based token
  try {
    const data = await fs.readFile(TOKEN_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(data);

    if (!isPelotonAuthToken(parsed)) {
      throw new CookieStoreError('Token file format is invalid');
    }

    if (isTokenExpired(parsed)) {
      const minutesExpired = Math.floor((Date.now() - parsed.expires_at) / (60 * 1000));
      console.error(`[Token] Stored token expired ${minutesExpired} minutes ago`);
      return null;
    }

    const minutesRemaining = Math.floor((parsed.expires_at - Date.now()) / (60 * 1000));
    console.error(`[Token] Loaded valid token (expires in ${minutesRemaining} minutes)`);
    return parsed;
  } catch (error: unknown) {
    const enoent = typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === 'ENOENT';

    if (enoent) {
      console.error('[Token] No stored token file found');
      return null;
    }

    console.error('[Token] Error reading token file:', isError(error) ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Save JWT token to file.
 * On Fly.io, logs a message suggesting to update the PELOTON_BEARER_TOKEN secret.
 */
export async function saveToken(token: PelotonAuthToken): Promise<void> {
  if (!token.access_token || token.access_token.trim().length === 0) {
    throw new CookieStoreError('Cannot save token with empty access_token');
  }

  try {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2));

    const expiryDate = new Date(token.expires_at).toLocaleString();
    console.error(`[Token] Saved token for user ${token.user_id} (expires ${expiryDate})`);

    if (process.env.FLY_APP_NAME) {
      console.error(
        `[Token] Running on Fly.io — update secret with:\n` +
        `  flyctl secrets set PELOTON_BEARER_TOKEN="${token.access_token}" --app ${process.env.FLY_APP_NAME}`
      );
    }
  } catch (error: unknown) {
    throw new CookieStoreError(
      `Failed to save token: ${isError(error) ? error.message : 'Unknown error'}`,
      error
    );
  }
}

/**
 * Check if a token is expired (with 1 minute buffer).
 */
export function isTokenExpired(token: PelotonAuthToken): boolean {
  const bufferMs = 60 * 1000; // 1 minute buffer
  return token.expires_at - Date.now() < bufferMs;
}

/**
 * Delete stored token file.
 */
export async function clearToken(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
    console.error('[Token] Deleted stored token file');
  } catch (error: unknown) {
    const enoent = typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === 'ENOENT';
    if (!enoent) {
      console.error('[Token] Error deleting token file:', isError(error) ? error.message : 'Unknown error');
    }
  }
}
