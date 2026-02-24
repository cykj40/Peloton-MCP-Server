import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { PELOTON_API_URL } from '../constants.js';
import { loginWithPassword, refreshToken } from '../services/pelotonAuth.js';
import { PelotonAuthToken } from '../services/tokenStore.js';

describe('pelotonAuth', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('loginWithPassword', () => {
    it('returns Bearer token from Authorization header on success', async () => {
      nock(PELOTON_API_URL)
        .post('/auth/login', {
          username_or_email: 'test@example.com',
          password: 'password123',
        })
        .reply(200, { user_id: 'user123' }, { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.token' });

      const result = await loginWithPassword('test@example.com', 'password123');

      expect(result.access_token).toBe('eyJhbGciOiJSUzI1NiJ9.fake.token');
      expect(result.token_type).toBe('Bearer');
      expect(result.user_id).toBe('user123');
    });

    it('throws PelotonAuthError when Authorization header is missing', async () => {
      nock(PELOTON_API_URL)
        .post('/auth/login')
        .reply(200, { session_id: 'old-session' });

      await expect(loginWithPassword('test@example.com', 'password123')).rejects.toThrow(
        'Auth response missing Bearer token in Authorization header'
      );
    });

    it('throws PelotonAuthError on 401 response', async () => {
      nock(PELOTON_API_URL)
        .post('/auth/login')
        .reply(401, { message: 'Invalid credentials' });

      await expect(loginWithPassword('test@example.com', 'wrongpass')).rejects.toThrow('Auth login failed (401)');
    });

    it('throws PelotonAuthError on network error', async () => {
      nock(PELOTON_API_URL)
        .post('/auth/login')
        .replyWithError('Network error');

      await expect(loginWithPassword('test@example.com', 'password123')).rejects.toThrow('Failed to login');
    });
  });

  describe('refreshToken', () => {
    it('uses refresh_token endpoint when token has refresh_token field', async () => {
      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };

      nock(PELOTON_API_URL)
        .post('/auth/token/refresh', { refresh_token: 'refresh123' })
        .reply(200, {}, { Authorization: 'Bearer eyJnew.token.here' });

      const result = await refreshToken(token);

      expect(result).not.toBeNull();
      expect(result?.access_token).toBe('eyJnew.token.here');
      expect(result?.refresh_token).toBe('refresh123');
    });

    it('falls back to loginWithPassword when refresh fails and credentials provided', async () => {
      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };

      nock(PELOTON_API_URL)
        .post('/auth/token/refresh')
        .reply(401, { error: 'refresh failed' });

      nock(PELOTON_API_URL)
        .post('/auth/login')
        .reply(200, { user_id: 'user123' }, { Authorization: 'Bearer eyJnew.login.token' });

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

    it('returns null when refresh fails and re-login fails', async () => {
      const token: PelotonAuthToken = {
        access_token: 'old_token',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        expires_at: Date.now() - 1000,
        user_id: 'user123',
      };

      nock(PELOTON_API_URL)
        .post('/auth/token/refresh')
        .reply(401, { error: 'refresh failed' });

      nock(PELOTON_API_URL)
        .post('/auth/login')
        .reply(401, { error: 'login failed' });

      const result = await refreshToken(token, 'test@example.com', 'wrongpass');

      expect(result).toBeNull();
    });
  });
});
