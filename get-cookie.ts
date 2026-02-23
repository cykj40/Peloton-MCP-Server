#!/usr/bin/env node
import { chromium } from 'playwright';

/**
 * Helper script to extract Peloton session cookie
 * Opens a browser window for you to log in, then extracts the cookie
 */
async function getCookie() {
  console.log('🚀 Opening browser...');
  console.log('📝 Please log in to Peloton when the browser opens\n');

  const browser = await chromium.launch({
    headless: false, // Show the browser
    args: ['--disable-gpu'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    // Navigate to Peloton
    await page.goto('https://members.onepeloton.com/login');

    console.log('⏳ Waiting for you to log in...');
    console.log('   (The script will automatically detect when you\'re logged in)\n');

    // Wait for successful login
    await page.waitForURL('**/home', { timeout: 300000 }); // 5 minutes

    console.log('✅ Login detected! Extracting cookies...\n');

    // Wait a bit for all cookies to be set
    await page.waitForTimeout(2000);

    // Use CDP to get all cookies
    const client = await context.newCDPSession(page);
    const allCookies = await client.send('Network.getAllCookies');

    // Find the session cookie
    const sessionCookie = allCookies.cookies.find((c: any) => c.name === 'peloton_session_id');

    await browser.close();

    if (!sessionCookie) {
      console.error('❌ Error: peloton_session_id cookie not found');
      console.error('\nCookies found:');
      allCookies.cookies.forEach((c: any) => {
        console.error(`   - ${c.name} (${c.domain})`);
      });
      console.error('\nThe peloton_session_id cookie may only be available in the mobile app.');
      console.error('Please manually extract it from your browser\'s DevTools.');
      process.exit(1);
    }

    console.log('✨ Success! Your session cookie:\n');
    console.log('━'.repeat(80));
    console.log(sessionCookie.value);
    console.log('━'.repeat(80));
    console.log('\n📋 Copy this value and add it to your .env file as:');
    console.log('   PELOTON_SESSION_COOKIE=' + sessionCookie.value);
    console.log('\n💡 Or run this command:');
    console.log(`   echo "PELOTON_SESSION_COOKIE=${sessionCookie.value}" >> .env`);

  } catch (error) {
    await browser.close();
    console.error('❌ Error:', (error as Error).message);
    process.exit(1);
  }
}

getCookie();
