import { chromium } from 'playwright';

/**
 * Refresh Peloton session cookie using Playwright headless browser
 * This automates the login process to get a fresh session cookie
 */
export async function refreshPelotonCookie(
  username: string,
  password: string
): Promise<string> {
  console.error('[Auth] Starting Playwright browser for cookie refresh...');

  const browser = await chromium.launch({
    headless: true,
    // Disable GPU for server environments
    args: ['--disable-gpu', '--no-sandbox']
  });

  const context = await browser.newContext({
    // Mimic real browser to avoid detection
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    // Navigate to Peloton login page
    console.error('[Auth] Navigating to Peloton login page...');
    await page.goto('https://members.onepeloton.com/login', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for login form to be ready
    console.error('[Auth] Waiting for login form...');
    await page.waitForSelector('input[name="usernameOrEmail"]', { timeout: 10000 });

    // Fill in credentials
    console.error('[Auth] Entering credentials...');
    await page.fill('input[name="usernameOrEmail"]', username);
    await page.fill('input[name="password"]', password);

    // Click login button
    console.error('[Auth] Clicking login button...');
    await page.click('button[type="submit"]');

    // Wait for successful login (redirect to home page)
    console.error('[Auth] Waiting for login to complete...');
    await page.waitForURL('**/home', { timeout: 15000 });

    console.error('[Auth] Login successful, navigating to API to trigger session cookie...');

    // Navigate to API endpoint
    await page.goto('https://api.onepeloton.com/api/me', { timeout: 10000 });
    await page.waitForTimeout(3000); // Wait for cookies

    // Use CDP to get all cookies including HTTP-only
    const client = await context.newCDPSession(page);
    const allCookies = await client.send('Network.getAllCookies');

    console.error('[Auth] All cookies (including HTTP-only):', allCookies.cookies.map((c: any) => `${c.name} (${c.domain})`).join(', '));

    // Find the session cookie
    let sessionCookie = allCookies.cookies.find((c: any) => c.name === 'peloton_session_id');

    await browser.close();

    if (!sessionCookie) {
      throw new Error('peloton_session_id cookie not found. Peloton may have changed their auth system. Found: ' + allCookies.cookies.map((c: any) => c.name).join(', '));
    }

    console.error('[Auth] Successfully extracted session cookie (HTTP-only:', sessionCookie.httpOnly, ')');
    return sessionCookie.value;

  } catch (error) {
    await browser.close();
    console.error('[Auth] Error during cookie refresh:', error);
    throw new Error(`Failed to refresh Peloton cookie: ${(error as Error).message}`);
  }
}
