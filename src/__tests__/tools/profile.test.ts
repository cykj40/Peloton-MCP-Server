import { vi } from 'vitest';
import { handleProfileTool } from '../../tools/profile.js';

describe('handleProfileTool', () => {
  it('returns OK for successful test connection', async () => {
    const client = {
      testConnection: vi.fn().mockResolvedValue({ success: true, details: 'Connected', userId: 'u1' }),
      getUserProfile: vi.fn(),
    } as unknown as Parameters<typeof handleProfileTool>[2];

    const result = await handleProfileTool('peloton_test_connection', {}, client);
    expect(result.content[0]?.text.startsWith('OK:')).toBe(true);
  });

  it('returns ERROR for failed test connection', async () => {
    const client = {
      testConnection: vi.fn().mockResolvedValue({ success: false, details: 'Failed' }),
      getUserProfile: vi.fn(),
    } as unknown as Parameters<typeof handleProfileTool>[2];

    const result = await handleProfileTool('peloton_test_connection', {}, client);
    expect(result.content[0]?.text.startsWith('ERROR:')).toBe(true);
  });

  it('returns markdown profile', async () => {
    const client = {
      testConnection: vi.fn(),
      getUserProfile: vi.fn().mockResolvedValue({
        id: 'u1',
        username: 'testuser',
        total_workouts: 123,
        total_followers: 10,
        total_following: 20,
        created_at: 1_700_000_000,
      }),
    } as unknown as Parameters<typeof handleProfileTool>[2];

    const result = await handleProfileTool('peloton_get_profile', { response_format: 'markdown' }, client);
    expect(result.content[0]?.text).toContain('testuser');
    expect(result.content[0]?.text).toContain('123');
  });

  it('returns json profile', async () => {
    const client = {
      testConnection: vi.fn(),
      getUserProfile: vi.fn().mockResolvedValue({
        id: 'u1',
        username: 'testuser',
        total_workouts: 123,
      }),
    } as unknown as Parameters<typeof handleProfileTool>[2];

    const result = await handleProfileTool('peloton_get_profile', { response_format: 'json' }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { username: string; total_workouts: number };
    expect(parsed.username).toBe('testuser');
    expect(parsed.total_workouts).toBe(123);
  });
});
