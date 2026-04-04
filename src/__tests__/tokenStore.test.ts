import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises');

import * as fs from 'fs/promises';
import { loadToken, saveToken, isTokenExpired, clearToken, PelotonAuthToken } from '../services/tokenStore.js';

const fsMock = vi.mocked(fs);

describe('tokenStore', () => {
  let originalEnvToken: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Remove env var so file-based tests are not short-circuited
    originalEnvToken = process.env.PELOTON_BEARER_TOKEN;
    delete process.env.PELOTON_BEARER_TOKEN;
  });

  afterEach(() => {
    // Restore env var
    if (originalEnvToken !== undefined) {
      process.env.PELOTON_BEARER_TOKEN = originalEnvToken;
    } else {
      delete process.env.PELOTON_BEARER_TOKEN;
    }
  });

  describe('loadToken', () => {
    it('returns null when file does not exist', async () => {
      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      fsMock.readFile.mockRejectedValue(error);

      const result = await loadToken();
      expect(result).toBeNull();
    });

    it('returns null when file is corrupted JSON', async () => {
      fsMock.readFile.mockResolvedValue('not valid json{');

      const result = await loadToken();
      expect(result).toBeNull();
    });

    it('returns null when token is expired', async () => {
      const expiredToken: PelotonAuthToken = {
        access_token: 'eyJtest',
        token_type: 'Bearer',
        expires_at: Date.now() - 5 * 60 * 1000, // 5 minutes ago
        user_id: 'user123',
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(expiredToken));

      const result = await loadToken();
      expect(result).toBeNull();
    });

    it('returns token when valid and not expired', async () => {
      const validToken: PelotonAuthToken = {
        access_token: 'eyJvalid',
        token_type: 'Bearer',
        expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes from now
        user_id: 'user456',
      };
      fsMock.readFile.mockResolvedValue(JSON.stringify(validToken));

      const result = await loadToken();
      expect(result).toEqual(validToken);
    });

    it('returns null when file has invalid shape', async () => {
      fsMock.readFile.mockResolvedValue(JSON.stringify({ invalid: 'shape' }));

      const result = await loadToken();
      expect(result).toBeNull();
    });

    it('returns token from PELOTON_BEARER_TOKEN env var when valid', async () => {
      // Create a fake JWT with a future exp
      const futureExp = Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ exp: futureExp, sub: 'user-from-env', 'http://onepeloton.com/user_id': 'env-user-id' })
      ).toString('base64url');
      const fakeJwt = `${header}.${payload}.fakesig`;

      process.env.PELOTON_BEARER_TOKEN = fakeJwt;

      const result = await loadToken();
      expect(result).not.toBeNull();
      expect(result?.access_token).toBe(fakeJwt);
      expect(fsMock.readFile).not.toHaveBeenCalled();
    });

    it('returns token with default expiry and unknown user_id when JWT payload is invalid JSON', async () => {
      // 'YQ' decodes to 'a' in base64 — valid base64 but invalid JSON, triggers catch blocks
      process.env.PELOTON_BEARER_TOKEN = 'eyJhbGciOiJub25lIn0.YQ.sig';

      const result = await loadToken();
      expect(result).not.toBeNull();
      expect(result?.user_id).toBe('unknown');
      // Expiry is defaulted to 2 days from now
      expect(result!.expires_at).toBeGreaterThan(Date.now());
    });

    it('falls back to file when PELOTON_BEARER_TOKEN env var is expired', async () => {
      // Create a fake JWT with a past exp
      const pastExp = Math.floor((Date.now() - 60 * 1000) / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ exp: pastExp, sub: 'expired-user' })).toString('base64url');
      const expiredJwt = `${header}.${payload}.fakesig`;

      process.env.PELOTON_BEARER_TOKEN = expiredJwt;

      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      fsMock.readFile.mockRejectedValue(error);

      const result = await loadToken();
      expect(result).toBeNull();
      expect(fsMock.readFile).toHaveBeenCalled();
    });
  });

  describe('saveToken', () => {
    it('throws when access_token is empty', async () => {
      const invalidToken: PelotonAuthToken = {
        access_token: '',
        token_type: 'Bearer',
        expires_at: Date.now() + 60000,
        user_id: 'user123',
      };

      await expect(saveToken(invalidToken)).rejects.toThrow('Cannot save token with empty access_token');
    });

    it('writes token to file with correct structure', async () => {
      const validToken: PelotonAuthToken = {
        access_token: 'eyJvalid',
        token_type: 'Bearer',
        expires_at: Date.now() + 60000,
        user_id: 'user123',
      };
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);

      await saveToken(validToken);

      expect(fsMock.mkdir).toHaveBeenCalled();
      expect(fsMock.writeFile).toHaveBeenCalled();
    });

    it('logs Fly.io hint when FLY_APP_NAME is set', async () => {
      const validToken: PelotonAuthToken = {
        access_token: 'eyJvalid',
        token_type: 'Bearer',
        expires_at: Date.now() + 60000,
        user_id: 'user123',
      };
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockResolvedValue(undefined);
      process.env.FLY_APP_NAME = 'peloton-mcp-test';

      try {
        await saveToken(validToken);
      } finally {
        delete process.env.FLY_APP_NAME;
      }

      expect(fsMock.writeFile).toHaveBeenCalled();
    });

    it('throws CookieStoreError when writeFile fails', async () => {
      const validToken: PelotonAuthToken = {
        access_token: 'eyJvalid',
        token_type: 'Bearer',
        expires_at: Date.now() + 60000,
        user_id: 'user123',
      };
      fsMock.mkdir.mockResolvedValue(undefined);
      fsMock.writeFile.mockRejectedValue(new Error('disk full'));

      await expect(saveToken(validToken)).rejects.toThrow('Failed to save token');
    });
  });

  describe('isTokenExpired', () => {
    it('returns true when expires_at is in the past', () => {
      const expiredToken: PelotonAuthToken = {
        access_token: 'eyJtest',
        token_type: 'Bearer',
        expires_at: Date.now() - 5 * 60 * 1000,
        user_id: 'user123',
      };

      expect(isTokenExpired(expiredToken)).toBe(true);
    });

    it('returns false when expires_at is in the future beyond buffer', () => {
      const validToken: PelotonAuthToken = {
        access_token: 'eyJtest',
        token_type: 'Bearer',
        expires_at: Date.now() + 10 * 60 * 1000,
        user_id: 'user123',
      };

      expect(isTokenExpired(validToken)).toBe(false);
    });

    it('returns true when within the 1 minute buffer window', () => {
      const bufferToken: PelotonAuthToken = {
        access_token: 'eyJtest',
        token_type: 'Bearer',
        expires_at: Date.now() + 30 * 1000, // 30 seconds from now, within 1 min buffer
        user_id: 'user123',
      };

      expect(isTokenExpired(bufferToken)).toBe(true);
    });
  });

  describe('clearToken', () => {
    it('deletes the file when it exists', async () => {
      fsMock.unlink.mockResolvedValue(undefined);

      await clearToken();

      expect(fsMock.unlink).toHaveBeenCalled();
    });

    it('does not throw when file does not exist', async () => {
      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      fsMock.unlink.mockRejectedValue(error);

      await expect(clearToken()).resolves.not.toThrow();
    });

    it('logs error for non-ENOENT failures', async () => {
      const error: NodeJS.ErrnoException = new Error('Permission denied');
      error.code = 'EPERM';
      fsMock.unlink.mockRejectedValue(error);

      await expect(clearToken()).resolves.not.toThrow();
    });
  });
});
