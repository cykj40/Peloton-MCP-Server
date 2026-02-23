import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { CookieStoreError, isError } from '../types/errors.js';

interface CookieData {
  value: string;
  expiresAt: number;
  createdAt: number;
  type?: 'cookie' | 'bearer';
}

const COOKIE_DIR = path.join(process.env.APPDATA || os.homedir(), '.peloton');
const COOKIE_FILE = path.join(COOKIE_DIR, 'cookie.json');
const COOKIE_LIFETIME = 25 * 24 * 60 * 60 * 1000;
const BEARER_LIFETIME = 2 * 24 * 60 * 60 * 1000;
const CookieDataSchema = z.object({
  value: z.string(),
  expiresAt: z.number(),
  createdAt: z.number(),
  type: z.enum(['cookie', 'bearer']).optional(),
});

function isCookieData(value: unknown): value is CookieData {
  return CookieDataSchema.safeParse(value).success;
}

/**
 * Load stored cookie from file.
 * Returns null if file doesn't exist, is corrupted, or cookie is expired.
 */
export async function loadCookie(): Promise<string | null> {
  try {
    const data = await fs.readFile(COOKIE_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(data);

    if (!isCookieData(parsed)) {
      throw new CookieStoreError('Cookie file format is invalid');
    }

    if (Date.now() >= parsed.expiresAt) {
      const daysExpired = Math.floor((Date.now() - parsed.expiresAt) / (24 * 60 * 60 * 1000));
      console.error(`[Cookie] Stored cookie expired ${daysExpired} days ago`);
      return null;
    }

    const daysRemaining = Math.floor((parsed.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
    console.error(`[Cookie] Loaded valid cookie (expires in ${daysRemaining} days)`);
    return parsed.value;
  } catch (error: unknown) {
    const enoent = typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === 'ENOENT';

    if (enoent) {
      console.error('[Cookie] No stored cookie file found');
      return null;
    }

    console.error('[Cookie] Error reading cookie file:', isError(error) ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Save cookie to file with expiry timestamp.
 */
export async function saveCookie(value: string): Promise<void> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CookieStoreError('Cannot save empty cookie value');
  }

  const isBearer = value.startsWith('eyJ');

  try {
    const now = Date.now();
    let expiresAt = now + (isBearer ? BEARER_LIFETIME : COOKIE_LIFETIME);

    if (isBearer) {
      try {
        const payload = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString());
        if (typeof payload.exp === 'number') {
          expiresAt = payload.exp * 1000;
        }
      } catch { /* use default expiry */ }
    }

    const cookieData: CookieData = {
      value,
      expiresAt,
      createdAt: now,
      type: isBearer ? 'bearer' : 'cookie',
    };

    await fs.mkdir(COOKIE_DIR, { recursive: true });
    await fs.writeFile(COOKIE_FILE, JSON.stringify(cookieData, null, 2));

    const expiryDate = new Date(cookieData.expiresAt).toLocaleDateString();
    console.error(`[Cookie] Saved cookie (expires on ${expiryDate})`);
  } catch (error: unknown) {
    throw new CookieStoreError(
      `Failed to save cookie: ${isError(error) ? error.message : 'Unknown error'}`,
      error
    );
  }
}

/**
 * Delete stored cookie file.
 */
export async function deleteCookie(): Promise<void> {
  try {
    await fs.unlink(COOKIE_FILE);
    console.error('[Cookie] Deleted stored cookie file');
  } catch (error: unknown) {
    const enoent = typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === 'ENOENT';
    if (!enoent) {
      console.error('[Cookie] Error deleting cookie file:', isError(error) ? error.message : 'Unknown error');
    }
  }
}
