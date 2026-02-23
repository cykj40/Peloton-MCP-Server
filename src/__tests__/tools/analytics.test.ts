import { handleAnalyticsTool } from '../../tools/analytics.js';
import { makeMockWorkout } from '../fixtures.js';

describe('handleAnalyticsTool', () => {
  const workouts = [
    makeMockWorkout({ id: 'a', fitness_discipline: 'cycling' }),
    makeMockWorkout({ id: 'b', fitness_discipline: 'running', duration: 1200 }),
  ];

  it('handles peloton_muscle_activity markdown and json', async () => {
    const client = {
      getRecentWorkouts: jest.fn().mockResolvedValue(workouts),
    } as unknown as Parameters<typeof handleAnalyticsTool>[2];

    const markdown = await handleAnalyticsTool(
      'peloton_muscle_activity',
      { period: '7_days', response_format: 'markdown' },
      client
    );
    expect(markdown.content[0]?.text).toContain('# Muscle Activity');

    const json = await handleAnalyticsTool(
      'peloton_muscle_activity',
      { period: '7_days', response_format: 'json' },
      client
    );
    const parsed = JSON.parse(json.content[0]?.text ?? '{}') as { muscle_activity: Record<string, number> };
    expect(parsed.muscle_activity).toBeDefined();
  });

  it('handles peloton_muscle_impact markdown and json', async () => {
    const client = {
      getRecentWorkouts: jest.fn().mockResolvedValue(workouts),
    } as unknown as Parameters<typeof handleAnalyticsTool>[2];

    const markdown = await handleAnalyticsTool(
      'peloton_muscle_impact',
      { period: '30_days', response_format: 'markdown' },
      client
    );
    expect(markdown.content[0]?.text).toContain('# Muscle Impact');

    const json = await handleAnalyticsTool(
      'peloton_muscle_impact',
      { period: '30_days', response_format: 'json' },
      client
    );
    const parsed = JSON.parse(json.content[0]?.text ?? '{}') as { muscle_impact: Record<string, unknown> };
    expect(parsed.muscle_impact).toBeDefined();
  });

  it('handles peloton_workout_stats markdown and json', async () => {
    const client = {
      getRecentWorkouts: jest.fn().mockResolvedValue(workouts),
    } as unknown as Parameters<typeof handleAnalyticsTool>[2];

    const markdown = await handleAnalyticsTool(
      'peloton_workout_stats',
      { response_format: 'markdown' },
      client
    );
    expect(markdown.content[0]?.text).toContain('# Workout Statistics');

    const json = await handleAnalyticsTool(
      'peloton_workout_stats',
      { response_format: 'json' },
      client
    );
    const parsed = JSON.parse(json.content[0]?.text ?? '{}') as { total_workouts: number };
    expect(parsed.total_workouts).toBe(2);
  });

  it('handles peloton_training_balance markdown and json', async () => {
    const client = {
      getRecentWorkouts: jest.fn().mockResolvedValue(workouts),
    } as unknown as Parameters<typeof handleAnalyticsTool>[2];

    const markdown = await handleAnalyticsTool(
      'peloton_training_balance',
      { period: '90_days', response_format: 'markdown' },
      client
    );
    expect(markdown.content[0]?.text).toContain('# Training Balance');

    const json = await handleAnalyticsTool(
      'peloton_training_balance',
      { period: '90_days', response_format: 'json' },
      client
    );
    const parsed = JSON.parse(json.content[0]?.text ?? '{}') as { balance: { upperBody: number } };
    expect(parsed.balance.upperBody).toBeGreaterThanOrEqual(0);
  });

  it('handles empty workouts for all tools', async () => {
    const client = {
      getRecentWorkouts: jest.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof handleAnalyticsTool>[2];

    const activity = await handleAnalyticsTool(
      'peloton_muscle_activity',
      { period: '7_days', response_format: 'markdown' },
      client
    );
    const impact = await handleAnalyticsTool(
      'peloton_muscle_impact',
      { period: '7_days', response_format: 'markdown' },
      client
    );
    const training = await handleAnalyticsTool(
      'peloton_training_balance',
      { period: '7_days', response_format: 'markdown' },
      client
    );

    expect(activity.content[0]?.text).toContain('No workout data available');
    expect(impact.content[0]?.text).toContain('No workout data available');
    expect(training.content[0]?.text).toContain('# Training Balance');
  });
});
