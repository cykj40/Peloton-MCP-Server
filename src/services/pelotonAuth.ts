import { chromium } from 'playwright';
import { isError, PelotonAuthError } from '../types/errors.js';

export interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  httpOnly: boolean;
}

interface CDPGetAllCookiesResponse {
  cookies: CDPCookie[];
}

function isCDPCookie(value: unknown): value is CDPCookie {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const cookie = value;
  return (
    'name' in cookie &&
    typeof cookie.name === 'string' &&
    'value' in cookie &&
    typeof cookie.value === 'string' &&
    'domain' in cookie &&
    typeof cookie.domain === 'string' &&
    'httpOnly' in cookie &&
    typeof cookie.httpOnly === 'boolean'
  );
}

function isCDPGetAllCookiesResponse(value: unknown): value is CDPGetAllCookiesResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('cookies' in value) || !Array.isArray(value.cookies)) {
    return false;
  }

  return value.cookies.every(isCDPCookie);
}

/**
 * Refresh Peloton session cookie using Playwright headless browser.
 */
export async function refreshPelotonCookie(
  username: string,
  password: string
): Promise<string> {
  console.error('[Auth] Starting Playwright browser for cookie refresh...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--no-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    try {
      console.error('[Auth] Navigating to Peloton login page...');
      await page.goto('https://members.onepeloton.com/login', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      console.error('[Auth] Waiting for login form...');
      await page.waitForSelector('input[name="usernameOrEmail"]', { timeout: 10000 });

      console.error('[Auth] Entering credentials...');
      await page.fill('input[name="usernameOrEmail"]', username);
      await page.fill('input[name="password"]', password);

      console.error('[Auth] Clicking login button...');
      await page.click('button[type="submit"]');

      console.error('[Auth] Waiting for login to complete...');
      await page.waitForURL('**/home', { timeout: 15000 });

      console.error('[Auth] Login successful, navigating to API to trigger session cookie...');
      await page.goto('https://api.onepeloton.com/api/me', { timeout: 10000 });
      await page.waitForTimeout(3000);

      const client = await context.newCDPSession(page);
      const cdpResponseRaw: unknown = await client.send('Network.getAllCookies');
      if (!isCDPGetAllCookiesResponse(cdpResponseRaw)) {
        throw new PelotonAuthError('Invalid cookie payload returned by CDP');
      }

      const cdpResponse = cdpResponseRaw;
      const cookies = cdpResponse.cookies;

      console.error(
        '[Auth] All cookies (including HTTP-only):',
        cookies.map((cookie) => `${cookie.name} (${cookie.domain})`).join(', ')
      );

      const sessionCookie = cookies.find((cookie) => cookie.name === 'peloton_session_id');

      if (!sessionCookie) {
        const foundCookies = cookies.map((cookie) => cookie.name).join(', ');
        throw new PelotonAuthError(
          `peloton_session_id cookie not found. Peloton may have changed their auth system. Found: ${foundCookies}`
        );
      }

      console.error(
        '[Auth] Successfully extracted session cookie (HTTP-only:',
        sessionCookie.httpOnly,
        ')'
      );
      return sessionCookie.value;
    } catch (error: unknown) {
      throw new PelotonAuthError(
        `Failed to refresh Peloton cookie: ${isError(error) ? error.message : 'Unknown error'}`,
        error
      );
    }
  } finally {
    await browser.close();
  }
}
