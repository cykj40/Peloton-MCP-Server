import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createHttpApp } from '../http-server.js';
import { closeDatabase } from '../db/database.js';
import { getStoredAuthToken } from '../db/queries.js';
import { refreshOAuthTokenAndPersist } from '../services/pelotonAuth.js';
import { loadTokenIncludingExpired, saveToken, type PelotonAuthToken } from '../services/tokenStore.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

describe('HTTP token bootstrap', () => {
  let originalMcpAuthToken: string | undefined;

  beforeEach(async () => {
    originalMcpAuthToken = process.env.MCP_AUTH_TOKEN;
    process.env.MCP_AUTH_TOKEN = 'test-mcp-token';
    await setupTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalMcpAuthToken === undefined) {
      delete process.env.MCP_AUTH_TOKEN;
    } else {
      process.env.MCP_AUTH_TOKEN = originalMcpAuthToken;
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
    const bootstrap = createHttpApp().request('/update-peloton-token', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-mcp-token',
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
