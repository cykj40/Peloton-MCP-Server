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
 * Load stored JWT token from file.
 * Returns null if file doesn't exist, is corrupted, or token is expired.
 */
export async function loadToken(): Promise<PelotonAuthToken | null> {
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
