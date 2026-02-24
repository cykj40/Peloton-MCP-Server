import { vi } from 'vitest';
import { handleWorkoutTool } from '../../tools/workouts.js';
import { makeMockWorkout } from '../fixtures.js';

describe('handleWorkoutTool', () => {
  it('returns markdown workout details', async () => {
    const client = {
      searchWorkouts: vi.fn().mockResolvedValue([makeMockWorkout({ id: 'w1' })]),
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    const result = await handleWorkoutTool('peloton_get_workouts', { limit: 10, response_format: 'markdown' }, client);
    expect(result.content[0]?.text).toContain('# Peloton Workouts');
    expect(result.content[0]?.text).toContain('30 Min HIIT Ride');
  });

  it('returns json payload with total_workouts and workouts array', async () => {
    const client = {
      searchWorkouts: vi.fn().mockResolvedValue([makeMockWorkout({ id: 'w1' })]),
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    const result = await handleWorkoutTool('peloton_get_workouts', { limit: 10, response_format: 'json' }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { total_workouts: number; workouts: unknown[] };
    expect(parsed.total_workouts).toBe(1);
    expect(Array.isArray(parsed.workouts)).toBe(true);
  });

  it('passes discipline filter to searchWorkouts', async () => {
    const client = {
      searchWorkouts: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    await handleWorkoutTool('peloton_get_workouts', { limit: 10, discipline: 'cycling', response_format: 'json' }, client);

    expect(client.searchWorkouts).toHaveBeenCalledWith(
      expect.objectContaining({ discipline: 'cycling' })
    );
  });

  it('passes start_date and end_date as Date objects', async () => {
    const searchWorkouts = vi.fn().mockResolvedValue([]);
    const client = {
      searchWorkouts,
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    await handleWorkoutTool(
      'peloton_get_workouts',
      { limit: 10, start_date: '2025-01-01', end_date: '2025-01-10', response_format: 'json' },
      client
    );

    const call = searchWorkouts.mock.calls[0]?.[0] as { startDate?: Date; endDate?: Date };
    expect(call.startDate).toBeInstanceOf(Date);
    expect(call.endDate).toBeInstanceOf(Date);
  });

  it('renders empty results message', async () => {
    const client = {
      searchWorkouts: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    const result = await handleWorkoutTool('peloton_get_workouts', { limit: 10, response_format: 'markdown' }, client);
    expect(result.content[0]?.text).toContain('No workouts found');
  });

  it('passes instructor filter to searchWorkouts', async () => {
    const client = {
      searchWorkouts: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    await handleWorkoutTool(
      'peloton_get_workouts',
      { limit: 10, instructor: 'Robin', response_format: 'json' },
      client
    );

    expect(client.searchWorkouts).toHaveBeenCalledWith(
      expect.objectContaining({ instructor: 'Robin' })
    );
  });

  it('returns error for unknown tool name', async () => {
    const client = {
      searchWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    const result = await handleWorkoutTool('unknown_tool' as 'peloton_get_workouts', { limit: 10, response_format: 'json' }, client);

    expect(result.content[0]?.text).toBe('Unknown tool');
  });

  it('returns error message when client throws error', async () => {
    const client = {
      searchWorkouts: vi.fn().mockRejectedValue(new Error('API failure')),
    } as unknown as Parameters<typeof handleWorkoutTool>[2];

    const result = await handleWorkoutTool('peloton_get_workouts', { limit: 10, response_format: 'json' }, client);

    expect(result.content[0]?.text).toBe('Error: API failure');
  });
});
