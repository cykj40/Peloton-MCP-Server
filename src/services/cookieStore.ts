import fs from 'fs/promises';
import path from 'path';

interface CookieData {
  value: string;
  expiresAt: number; // Unix timestamp in milliseconds
  createdAt: number;
}

const COOKIE_FILE = path.join(process.cwd(), '.peloton-cookie.json');
const COOKIE_LIFETIME = 25 * 24 * 60 * 60 * 1000; // 25 days in milliseconds
// We refresh at 25 days instead of 30 to have a safety buffer

/**
 * Load stored cookie from file
 * Returns null if file doesn't exist, is corrupted, or cookie is expired
 */
export async function loadCookie(): Promise<string | null> {
  try {
    const data = await fs.readFile(COOKIE_FILE, 'utf-8');
    const cookieData: CookieData = JSON.parse(data);

    // Check if expired
    if (Date.now() >= cookieData.expiresAt) {
      const daysExpired = Math.floor((Date.now() - cookieData.expiresAt) / (24 * 60 * 60 * 1000));
      console.error(`[Cookie] Stored cookie expired ${daysExpired} days ago`);
      return null;
    }

    const daysRemaining = Math.floor((cookieData.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
    console.error(`[Cookie] Loaded valid cookie (expires in ${daysRemaining} days)`);
    return cookieData.value;

  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('[Cookie] No stored cookie file found');
    } else {
      console.error('[Cookie] Error reading cookie file:', (error as Error).message);
    }
    return null;
  }
}

/**
 * Save cookie to file with expiry timestamp
 */
export async function saveCookie(value: string): Promise<void> {
  const now = Date.now();
  const cookieData: CookieData = {
    value,
    expiresAt: now + COOKIE_LIFETIME,
    createdAt: now,
  };

  await fs.writeFile(COOKIE_FILE, JSON.stringify(cookieData, null, 2));

  const expiryDate = new Date(cookieData.expiresAt).toLocaleDateString();
  console.error(`[Cookie] Saved cookie (expires on ${expiryDate})`);
}

/**
 * Delete stored cookie file
 */
export async function deleteCookie(): Promise<void> {
  try {
    await fs.unlink(COOKIE_FILE);
    console.error('[Cookie] Deleted stored cookie file');
  } catch (error) {
    // File doesn't exist, that's fine
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[Cookie] Error deleting cookie file:', (error as Error).message);
    }
  }
}
