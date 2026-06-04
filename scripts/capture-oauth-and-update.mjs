/**
 * Captures auth.onepeloton.com/oauth/token from browser login, posts to Fly.
 * Never logs token values — only curl/API status output.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const TOKEN_CACHE = '/tmp/.peloton-oauth-capture.json'

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq)
      let val = trimmed.slice(eq + 1)
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  } catch {
    // optional file
  }
}

loadEnvFile(resolve(process.cwd(), '.env'))
loadEnvFile(resolve(process.cwd(), '../t1pilot/.env'))
loadEnvFile(resolve(process.cwd(), '../t1pilot/apps/web/.env.local'))

const username = process.env.PELOTON_USERNAME
const password = process.env.PELOTON_PASSWORD
const mcpAuth = process.env.PELOTON_MCP_AUTH_TOKEN ?? process.env.MCP_AUTH_TOKEN

if (!username || !password) {
  console.error('Missing PELOTON_USERNAME or PELOTON_PASSWORD in .env')
  process.exit(1)
}
if (!mcpAuth) {
  console.error('Missing PELOTON_MCP_AUTH_TOKEN (or MCP_AUTH_TOKEN) in .env')
  process.exit(1)
}

let oauthPayload = null

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
})
const page = await context.newPage()

page.on('response', async (response) => {
  const url = response.url()
  if (!url.includes('auth.onepeloton.com/oauth/token')) return
  if (response.request().method() !== 'POST') return
  if (response.status() < 200 || response.status() >= 300) return
  try {
    const body = await response.json()
    if (body && typeof body.access_token === 'string') {
      oauthPayload = body
    }
  } catch {
    // ignore parse errors
  }
})

try {
  await page.goto('https://members.onepeloton.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  })

  const email = page.locator('input[type="email"], input[name="username_or_email"], input[id*="email" i]').first()
  const pass = page.locator('input[type="password"]').first()
  await email.waitFor({ state: 'visible', timeout: 60_000 })
  await email.fill(username)
  await pass.fill(password)

  const submit = page.getByRole('button', { name: /log\s*in|sign\s*in/i }).first()
  await submit.click()

  const deadline = Date.now() + 120_000
  while (!oauthPayload && Date.now() < deadline) {
    await page.waitForTimeout(500)
  }

  if (!oauthPayload?.access_token) {
    console.error('Failed to capture oauth/token response within timeout')
    process.exit(1)
  }

  writeFileSync(
    TOKEN_CACHE,
    JSON.stringify({
      access_token: oauthPayload.access_token,
      refresh_token: oauthPayload.refresh_token ?? '',
    }),
    { mode: 0o600 },
  )

  const tokens = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'))
  const curlRes = await fetch('https://peloton-mcp-server.fly.dev/update-peloton-token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mcpAuth}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    }),
  })

  const text = await curlRes.text()
  console.log(`HTTP ${curlRes.status}`)
  console.log(text)
  process.exit(curlRes.ok ? 0 : 1)
} finally {
  await browser.close()
  try {
    unlinkSync(TOKEN_CACHE)
  } catch {
    // already removed
  }
}
