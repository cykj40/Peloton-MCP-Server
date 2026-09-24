import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createAdminApp, createHttpApp } from '../http-server.js';
import { closeDatabase } from '../db/database.js';
import { getStoredAuthToken } from '../db/queries.js';
import { refreshOAuthTokenAndPersist } from '../services/pelotonAuth.js';
import { loadTokenIncludingExpired, saveToken, type PelotonAuthToken } from '../services/tokenStore.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

describe('HTTP token bootstrap', () => {
  let originalMcpAuthToken: string | undefined;
  let originalUpdateSecret: string | undefined;

  beforeEach(async () => {
    originalMcpAuthToken = process.env.MCP_AUTH_TOKEN;
    originalUpdateSecret = process.env.PELOTON_TOKEN_UPDATE_SECRET;
    process.env.MCP_AUTH_TOKEN = 'test-mcp-token';
    process.env.PELOTON_TOKEN_UPDATE_SECRET = 'test-update-secret';
    await setupTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalMcpAuthToken === undefined) {
      delete process.env.MCP_AUTH_TOKEN;
    } else {
      process.env.MCP_AUTH_TOKEN = originalMcpAuthToken;
    }
    if (originalUpdateSecret === undefined) {
      delete process.env.PELOTON_TOKEN_UPDATE_SECRET;
    } else {
      process.env.PELOTON_TOKEN_UPDATE_SECRET = originalUpdateSecret;
    }
    await teardownTestDb();
  });

  it('writes the manual bootstrap token after an in-flight refresh settles', async () => {
    const oldToken: PelotonAuthToken = {
      access_token: 'eyJ.old.access',
      refresh_token: 'refresh-old',
      token_type: 'Bearer',
      expires_at: Date.now() - 1_000,
      user_id: 'user123',
    };
    await saveToken(oldToken);

    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.spyOn(axios, 'post').mockImplementationOnce(async () => {
      signalRefreshStarted();
      await release;
      return {
        status: 200,
        data: {
          access_token: 'eyJ.refreshed.access',
          refresh_token: 'refresh-rotated',
          expires_in: 172800,
        },
      } as never;
    });

    const refresh = refreshOAuthTokenAndPersist(oldToken);
    await refreshStarted;
    const bootstrap = createAdminApp().request('/update-peloton-token', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-update-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: 'eyJ.bootstrap.access', refresh_token: 'refresh-bootstrap' }),
    });

    releaseRefresh();
    await refresh;
    expect((await bootstrap).status).toBe(200);

    await expect(getStoredAuthToken()).resolves.toMatchObject({
      access_token: 'eyJ.bootstrap.access',
      refresh_token: 'refresh-bootstrap',
    });

    await closeDatabase();
    delete process.env.TURSO_DATABASE_URL;
    await expect(loadTokenIncludingExpired()).resolves.toMatchObject({
      access_token: 'eyJ.bootstrap.access',
      refresh_token: 'refresh-bootstrap',
    });
  });
});

describe('OAuth authorization code flow', () => {
  const clientId = 'test-client';
  const clientSecret = 'test-client-secret';
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  beforeEach(() => {
    vi.stubEnv('MCP_AUTH_TOKEN', 'test-mcp-token');
    vi.stubEnv('OAUTH_CLIENT_ID', clientId);
    vi.stubEnv('OAUTH_CLIENT_SECRET', clientSecret);
    vi.stubEnv('ALLOWED_REDIRECT_URIS', `${redirectUri}, https://claude.com/api/mcp/auth_callback`);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const authorize = (app: ReturnType<typeof createHttpApp>, overrides: Record<string, string> = {}) =>
    app.request(
      `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: 'xyz',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...overrides,
      })}`
    );

  const exchange = (app: ReturnType<typeof createHttpApp>, code: string, overrides: Record<string, string> = {}) =>
    app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        ...overrides,
      }).toString(),
    });

  const issueCode = async (app: ReturnType<typeof createHttpApp>): Promise<string> => {
    const res = await authorize(app);
    expect(res.status).toBe(302);
    return new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
  };

  it('advertises PKCE S256 support in OAuth discovery', async () => {
    const res = await createHttpApp().request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const metadata = await res.json();
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
  });

  it.each(['', 'short', 'x'.repeat(clientSecret.length)])(
    'rejects an invalid client secret %j without throwing',
    async (invalidSecret) => {
      const app = createHttpApp();
      const code = await issueCode(app);
      const res = await exchange(app, code, { client_secret: invalidSecret });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'invalid_client' });
    }
  );

  it('rejects an untrusted redirect_uri with 400 and does not redirect', async () => {
    const res = await authorize(createHttpApp(), { redirect_uri: 'https://attacker.example/callback' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).not.toContain('test-mcp-token');
  });

  it('rejects a redirect_uri that only prefix-matches an allowed URI', async () => {
    const res = await authorize(createHttpApp(), { redirect_uri: `${redirectUri}/extra` });
    expect(res.status).toBe(400);
  });

  it('accepts every allowlisted callback', async () => {
    const res = await authorize(createHttpApp(), { redirect_uri: 'https://claude.com/api/mcp/auth_callback' });
    expect(res.status).toBe(302);
  });

  it('requires a PKCE S256 code_challenge', async () => {
    const app = createHttpApp();
    expect((await authorize(app, { code_challenge: '' })).status).toBe(400);
    expect((await authorize(app, { code_challenge_method: 'plain' })).status).toBe(400);
  });

  it('never places the bearer in the redirect and returns it only from /token', async () => {
    const app = createHttpApp();
    const res = await authorize(app);
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain('test-mcp-token');
    const code = new URL(location).searchParams.get('code') ?? '';
    expect(new URL(location).searchParams.get('state')).toBe('xyz');

    const tokenRes = await exchange(app, code);
    expect(tokenRes.status).toBe(200);
    await expect(tokenRes.json()).resolves.toMatchObject({ access_token: 'test-mcp-token' });
  });

  it('rejects reuse of an authorization code', async () => {
    const app = createHttpApp();
    const code = await issueCode(app);
    expect((await exchange(app, code)).status).toBe(200);
    expect((await exchange(app, code)).status).toBe(400);
  });

  it('rejects a wrong code_verifier and burns the code', async () => {
    const app = createHttpApp();
    const code = await issueCode(app);
    expect((await exchange(app, code, { code_verifier: randomBytes(32).toString('base64url') })).status).toBe(400);
    expect((await exchange(app, code)).status).toBe(400);
  });

  it('rejects a code after the 60s TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const app = createHttpApp();
    const code = await issueCode(app);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await exchange(app, code)).status).toBe(400);
  });

  it('rejects a redirect_uri mismatch at /token', async () => {
    const app = createHttpApp();
    const code = await issueCode(app);
    expect((await exchange(app, code, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).status).toBe(400);
  });

  it('rejects the legacy code=MCP_AUTH_TOKEN exchange', async () => {
    expect((await exchange(createHttpApp(), 'test-mcp-token')).status).toBe(400);
  });
});

describe('manual Peloton token override', () => {
  const request = (app: ReturnType<typeof createAdminApp>, authorization?: string) =>
    app.request('/update-peloton-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ token: 'eyJ.attacker.access', refresh_token: 'attacker-refresh' }),
    });

  beforeEach(async () => {
    vi.stubEnv('MCP_AUTH_TOKEN', 'test-mcp-token');
    vi.stubEnv('PELOTON_TOKEN_UPDATE_SECRET', 'test-update-secret');
    await setupTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await teardownTestDb();
  });

  it('is not routed on the public app, even with a valid MCP bearer', async () => {
    const res = await request(createHttpApp(), 'Bearer test-mcp-token');
    expect(res.status).toBe(404);
    await expect(getStoredAuthToken()).resolves.not.toMatchObject({ access_token: 'eyJ.attacker.access' });
  });

  it('rejects the admin route without the separate update secret', async () => {
    const app = createAdminApp();
    expect((await request(app)).status).toBe(401);
    expect((await request(app, 'Bearer test-mcp-token')).status).toBe(401);
    expect((await request(app, 'Bearer wrong-secret')).status).toBe(401);
    await expect(getStoredAuthToken()).resolves.not.toMatchObject({ access_token: 'eyJ.attacker.access' });
  });

  it('rejects every request when PELOTON_TOKEN_UPDATE_SECRET is unset', async () => {
    vi.stubEnv('PELOTON_TOKEN_UPDATE_SECRET', undefined);
    expect((await request(createAdminApp(), 'Bearer test-update-secret')).status).toBe(401);
  });

  it('rejects the MCP bearer even when misconfigured as the update secret', async () => {
    vi.stubEnv('PELOTON_TOKEN_UPDATE_SECRET', 'test-mcp-token');
    expect((await request(createAdminApp(), 'Bearer test-mcp-token')).status).toBe(401);
  });
});
