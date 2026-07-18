import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';

vi.mock('../db/queries.js', () => ({
  getStoredAuthToken: vi.fn(),
  upsertAuthToken: vi.fn(),
  deleteStoredAuthToken: vi.fn(),
}));

import {
  PELOTON_API_URL,
  PELOTON_AUTH_CLIENT_ID,
  PELOTON_AUTH_TOKEN_URL,
} from '../constants.js';
import {
  loginWithPassword,
  refreshOAuthToken,
  refreshOAuthTokenAndPersist,
  refreshToken,
} from '../services/pelotonAuth.js';
import { getStoredAuthToken, upsertAuthToken } from '../db/queries.js';
import { loadTokenIncludingExpired, PelotonAuthToken, setRuntimeToken } from '../services/tokenStore.js';

const getStoredAuthTokenMock = vi.mocked(getStoredAuthToken);
const upsertAuthTokenMock = vi.mocked(upsertAuthToken);

function nockLoginPost(body?: Record<string, string>): nock.Scope {
  return nock(PELOTON_API_URL).post('/auth/login?=', body);
}

describe('pelotonAuth', () => {
  beforeEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
    getStoredAuthTokenMock.mockResolvedValue(null);
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  describe('loginWithPassword', () => {
    it('returns Bearer token from Authorization header on success', async () => {
      nockLoginPost({
        username_or_email: 'test@example.com',
        password: 'password123',
      }).reply(
        200,
        { user_id: 'user123' },
        {
          Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.token',
          'Set-Cookie': 'peloton_session_id=session-123; Path=/; Secure',
        }
      );

      const result = await loginWithPassword('test@example.com', 'password123');

      expect(result.access_token).toBe('eyJhbGciOiJSUzI1NiJ9.fake.token');
      expect(result.session_id).toBe('session-123');
      expect(result.token_type).toBe('Bearer');
      expect(result.user_id).toBe('user123');
    });

    it('throws PelotonAuthError when Authorization header is missing', async () => {
      nockLoginPost().reply(200, { session_id: 'old-session' });

      await expect(loginWithPassword('test@example.com', 'password123')).rejects.toThrow(
        'Auth response missing Bearer token in Authorization header'
      );
    });

    it('throws PelotonAuthError on 401 response', async () => {
      nockLoginPost().reply(401, { message: 'Invalid credentials' });

      await expect(loginWithPassword('test@example.com', 'wrongpass')).rejects.toThrow('Auth login failed (401)');
    });

    it('throws PelotonAuthError on network error', async () => {
      nockLoginPost().replyWithError('Network error');

      await expect(loginWithPassword('test@example.com', 'password123')).rejects.toThrow('Failed to login');
    });
  });

  describe('refreshOAuthToken', () => {
    it('returns rotated refresh token from Auth0', async () => {
      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh-old-secret',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };

      nock(PELOTON_AUTH_TOKEN_URL)
        .post('', (body: string) => {
          const params = new URLSearchParams(body);
          return (
            params.get('grant_type') === 'refresh_token' &&
            params.get('client_id') === PELOTON_AUTH_CLIENT_ID &&
            params.get('refresh_token') === 'refresh-old-secret'
          );
        })
        .reply(200, {
          access_token: 'eyJhbGciOiJSUzI1NiJ9.new.access',
          refresh_token: 'refresh-new-secret',
          token_type: 'Bearer',
          expires_in: 172800,
        });

      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await refreshOAuthToken(token);

      expect(result.access_token).toBe('eyJhbGciOiJSUzI1NiJ9.new.access');
      expect(result.refresh_token).toBe('refresh-new-secret');
      expect(result.expires_at).toBeGreaterThan(Date.now());

      const logged = stderrSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain('refresh-old-secret');
      expect(logged).not.toContain('refresh-new-secret');
      expect(logged).not.toContain('password123');
    });

    it('keeps a rotated token in memory and retries persistence after failures', async () => {
      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };

      nock(PELOTON_AUTH_TOKEN_URL)
        .post('')
        .reply(200, {
          access_token: 'eyJhbGciOiJSUzI1NiJ9.new.access',
          refresh_token: 'refresh456',
          expires_in: 172800,
        });

      upsertAuthTokenMock.mockRejectedValue(new Error('db unavailable'));

      const result = await refreshOAuthTokenAndPersist(token);

      expect(result.refresh_token).toBe('refresh456');
      expect(upsertAuthTokenMock).toHaveBeenCalledTimes(3);

      upsertAuthTokenMock.mockResolvedValue();
      await expect(loadTokenIncludingExpired()).resolves.toEqual(result);
      expect(upsertAuthTokenMock).toHaveBeenCalledTimes(4);
    });

    it('adopts a newer non-expiring Turso token instead of refreshing stale memory', async () => {
      const staleToken: PelotonAuthToken = {
        access_token: 'eyJ.stale.access',
        refresh_token: 'refresh-stale',
        token_type: 'Bearer',
        expires_at: Date.now() - 1_000,
        user_id: 'user123',
      };
      const tursoToken: PelotonAuthToken = {
        access_token: 'eyJ.turso.access',
        refresh_token: 'refresh-current',
        token_type: 'Bearer',
        expires_at: Date.now() + 3 * 60 * 60 * 1000,
        user_id: 'user123',
      };
      getStoredAuthTokenMock.mockResolvedValue(tursoToken);
      setRuntimeToken(staleToken);
      const axiosModule = await import('axios');
      const postSpy = vi.spyOn(axiosModule.default, 'post');

      await expect(refreshOAuthTokenAndPersist(staleToken)).resolves.toEqual(tursoToken);
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('shares concurrent refreshes in one Auth0 request', async () => {
      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        expires_at: Date.now() - 1_000,
        user_id: 'user123',
      };
      setRuntimeToken(token);
      const authScope = nock(PELOTON_AUTH_TOKEN_URL)
        .post('')
        .reply(200, {
          access_token: 'eyJhbGciOiJSUzI1NiJ9.single-flight',
          refresh_token: 'refresh456',
          expires_in: 172800,
        });

      const [first, second] = await Promise.all([
        refreshOAuthTokenAndPersist(token),
        refreshOAuthTokenAndPersist(token),
      ]);

      expect(first).toEqual(second);
      expect(authScope.isDone()).toBe(true);
    });
  });

  describe('refreshToken', () => {
    it('prefers OAuth refresh when refresh_token is present', async () => {
      const saveModule = await import('../services/tokenStore.js');
      vi.spyOn(saveModule, 'saveToken').mockResolvedValue();

      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };
      setRuntimeToken(token);

      nock(PELOTON_AUTH_TOKEN_URL)
        .post('')
        .reply(200, {
          access_token: 'eyJhbGciOiJSUzI1NiJ9.oauth.token',
          refresh_token: 'refresh456',
          expires_in: 172800,
        });

      const result = await refreshToken(token, 'test@example.com', 'password123');

      expect(result).not.toBeNull();
      expect(result?.access_token).toBe('eyJhbGciOiJSUzI1NiJ9.oauth.token');
      expect(result?.refresh_token).toBe('refresh456');
    });

    it('falls back to login when OAuth refresh fails', async () => {
      const saveModule = await import('../services/tokenStore.js');
      vi.spyOn(saveModule, 'saveToken').mockResolvedValue();

      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };
      setRuntimeToken(token);

      nock(PELOTON_AUTH_TOKEN_URL).post('').reply(401, { error: 'invalid_grant' });

      nockLoginPost().reply(200, { user_id: 'user123' }, { Authorization: 'Bearer eyJnew.login.token' });

      const result = await refreshToken(token, 'test@example.com', 'password123');

      expect(result).not.toBeNull();
      expect(result?.access_token).toBe('eyJnew.login.token');
    });

    it('returns null when no refresh_token and no credentials', async () => {
      const token: PelotonAuthToken = {
        access_token: 'old_token',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };

      const result = await refreshToken(token);

      expect(result).toBeNull();
    });
  });
});
