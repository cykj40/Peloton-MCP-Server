import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('fs/promises');

import * as fs from 'fs/promises';
import { loadToken, saveToken, isTokenExpired, clearToken, PelotonAuthToken } from '../services/tokenStore.js';

const fsMock = vi.mocked(fs);

describe('tokenStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });
});
