import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/queries.js', () => ({
  getStoredAuthToken: vi.fn(),
  upsertAuthToken: vi.fn(),
  deleteStoredAuthToken: vi.fn(),
}));

import { deleteStoredAuthToken, getStoredAuthToken, upsertAuthToken } from '../db/queries.js';
import {
  clearToken,
  isTokenExpired,
  isTokenExpiring,
  loadToken,
  loadTokenIncludingExpired,
  saveToken,
  setRuntimeToken,
  type PelotonAuthToken,
} from '../services/tokenStore.js';

const getStoredAuthTokenMock = vi.mocked(getStoredAuthToken);
const upsertAuthTokenMock = vi.mocked(upsertAuthToken);
const deleteStoredAuthTokenMock = vi.mocked(deleteStoredAuthToken);

describe('tokenStore', () => {
  let originalEnvToken: string | undefined;
  let originalEnvSessionCookie: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnvToken = process.env.PELOTON_BEARER_TOKEN;
    originalEnvSessionCookie = process.env.PELOTON_SESSION_COOKIE;
    delete process.env.PELOTON_BEARER_TOKEN;
    delete process.env.PELOTON_SESSION_COOKIE;
    getStoredAuthTokenMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalEnvToken !== undefined) {
      process.env.PELOTON_BEARER_TOKEN = originalEnvToken;
    } else {
      delete process.env.PELOTON_BEARER_TOKEN;
    }

    if (originalEnvSessionCookie !== undefined) {
      process.env.PELOTON_SESSION_COOKIE = originalEnvSessionCookie;
    } else {
      delete process.env.PELOTON_SESSION_COOKIE;
    }
  });

  it('loads a valid token from the database first', async () => {
    const token: PelotonAuthToken = {
      access_token: 'eyJ.db.token',
      token_type: 'Bearer',
      expires_at: Date.now() + 180_000,
      user_id: 'db-user',
    };
    getStoredAuthTokenMock.mockResolvedValue(token);

    await expect(loadToken()).resolves.toEqual(token);
  });

  it('falls back to env token when the database has no valid token', async () => {
    const futureExp = Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ exp: futureExp, 'http://onepeloton.com/user_id': 'env-user' })
    ).toString('base64url');
    process.env.PELOTON_BEARER_TOKEN = `${header}.${payload}.sig`;
    process.env.PELOTON_SESSION_COOKIE = 'peloton_session_id=session-from-env; Path=/';

    const token = await loadToken();

    expect(token?.user_id).toBe('env-user');
    expect(token?.session_id).toBe('session-from-env');
  });

  it('uses runtime token before database or env', async () => {
    const token: PelotonAuthToken = {
      access_token: 'eyJ.runtime.token',
      token_type: 'Bearer',
      expires_at: Date.now() + 120_000,
      user_id: 'runtime-user',
    };
    setRuntimeToken(token);

    await expect(loadToken()).resolves.toEqual(token);
    expect(getStoredAuthTokenMock).not.toHaveBeenCalled();

    await clearToken();
  });

  it('returns null when no valid token exists', async () => {
    await expect(loadToken()).resolves.toBeNull();
  });

  it('can load an expired persisted token for proactive auth repair', async () => {
    const token: PelotonAuthToken = {
      access_token: 'eyJ.expired.token',
      token_type: 'Bearer',
      expires_at: Date.now() - 60_000,
      user_id: 'expired-user',
    };
    getStoredAuthTokenMock.mockResolvedValue(token);

    await expect(loadToken()).resolves.toBeNull();
    await expect(loadTokenIncludingExpired()).resolves.toEqual(token);
  });

  it('saves tokens through the database layer', async () => {
    const token: PelotonAuthToken = {
      access_token: 'eyJ.saved.token',
      token_type: 'Bearer',
      expires_at: Date.now() + 120_000,
      user_id: 'saved-user',
      session_id: 'saved-session',
    };

    await saveToken(token);

    expect(upsertAuthTokenMock).toHaveBeenCalledWith(token);
  });

  it('clears runtime and database token state', async () => {
    setRuntimeToken({
      access_token: 'eyJ.runtime.token',
      token_type: 'Bearer',
      expires_at: Date.now() + 120_000,
      user_id: 'runtime-user',
    });

    await clearToken();

    expect(deleteStoredAuthTokenMock).toHaveBeenCalled();
    await expect(loadToken()).resolves.toBeNull();
  });

  it('treats tokens inside the one-minute buffer as expired', () => {
    expect(
      isTokenExpired({
        access_token: 'eyJ.buffer.token',
        token_type: 'Bearer',
        expires_at: Date.now() + 30_000,
        user_id: 'buffer-user',
      })
    ).toBe(true);
  });

  it('treats tokens inside the proactive two-hour buffer as expiring', () => {
    expect(
      isTokenExpiring({
        access_token: 'eyJ.buffer.token',
        token_type: 'Bearer',
        expires_at: Date.now() + 60 * 60 * 1000,
        user_id: 'buffer-user',
      })
    ).toBe(true);
  });
});
