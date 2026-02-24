import { vi } from 'vitest';
import { handleCorrelationTool } from '../../tools/correlations.js';
import { insertGlucoseCorrelation, upsertWorkout } from '../../db/queries.js';
import { makeMockWorkout } from '../fixtures.js';
import { setupTestDb, teardownTestDb } from '../testDb.js';

describe('handleCorrelationTool', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('peloton_sync_workouts calls client and returns count message', async () => {
    const client = {
      getRecentWorkouts: vi.fn().mockResolvedValue([makeMockWorkout({ id: 'sync-1' })]),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool('peloton_sync_workouts', { limit: 1 }, client);
    expect(client.getRecentWorkouts).toHaveBeenCalledWith(1);
    expect(result.content[0]?.text).toContain('Synced 1 workouts');
  });

  it('peloton_analyze_glucose_correlation returns error for missing workout', async () => {
    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool(
      'peloton_analyze_glucose_correlation',
      {
        workout_id: 'missing',
        glucose_readings: [{ value: 100, recordedAt: new Date().toISOString() }],
        response_format: 'markdown',
      },
      client
    );

    expect(result.content[0]?.text).toContain('not found in database');
  });

  it('peloton_analyze_glucose_correlation returns correlation for existing workout', async () => {
    const workout = makeMockWorkout({ id: 'corr-1', created_at: 1_700_000_000, duration: 1800 });
    upsertWorkout(workout);
    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool(
      'peloton_analyze_glucose_correlation',
      {
        workout_id: 'corr-1',
        glucose_readings: [
          { value: 130, recordedAt: new Date((workout.created_at - 10 * 60) * 1000).toISOString() },
          { value: 120, recordedAt: new Date(workout.created_at * 1000).toISOString() },
          { value: 80, recordedAt: new Date((workout.created_at + 90 * 60) * 1000).toISOString() },
        ],
        response_format: 'json',
      },
      client
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { workout_id: string; avg_drop: number };
    expect(parsed.workout_id).toBe('corr-1');
    expect(parsed.avg_drop).toBe(40);
  });

  it('peloton_get_discipline_insights returns data in both formats', async () => {
    upsertWorkout(makeMockWorkout({ id: 'insight-1' }));
    insertGlucoseCorrelation({
      workout_id: 'insight-1',
      workout_timestamp: 1_700_000_000,
      discipline: 'cycling',
      duration_seconds: 1800,
      pre_workout_glucose: 130,
      glucose_at_start: 125,
      glucose_nadir: 80,
      glucose_nadir_time: 90,
      glucose_4h_post: 100,
      avg_drop: 45,
      recovery_time_minutes: 60,
      notes: null,
    });

    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const markdown = await handleCorrelationTool(
      'peloton_get_discipline_insights',
      { response_format: 'markdown' },
      client
    );
    const json = await handleCorrelationTool(
      'peloton_get_discipline_insights',
      { response_format: 'json' },
      client
    );

    expect(markdown.content[0]?.text).toContain('Glucose Impact by Workout Discipline');
    const parsed = JSON.parse(json.content[0]?.text ?? '[]') as Array<{ discipline: string }>;
    expect(parsed[0]?.discipline).toBe('cycling');
  });

  it('peloton_detect_hypoglycemia_risk returns alerts', async () => {
    upsertWorkout(makeMockWorkout({ id: 'alert-1' }));
    insertGlucoseCorrelation({
      workout_id: 'alert-1',
      workout_timestamp: 1_700_000_000,
      discipline: 'running',
      duration_seconds: 1800,
      pre_workout_glucose: 120,
      glucose_at_start: 115,
      glucose_nadir: 60,
      glucose_nadir_time: 140,
      glucose_4h_post: 100,
      avg_drop: 55,
      recovery_time_minutes: 80,
      notes: null,
    });

    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const markdown = await handleCorrelationTool(
      'peloton_detect_hypoglycemia_risk',
      { response_format: 'markdown' },
      client
    );
    const json = await handleCorrelationTool(
      'peloton_detect_hypoglycemia_risk',
      { response_format: 'json' },
      client
    );

    expect(markdown.content[0]?.text).toContain('Hypoglycemia Risk Alert');
    const parsed = JSON.parse(json.content[0]?.text ?? '[]') as Array<{ severity: string }>;
    expect(parsed[0]?.severity).toBe('moderate');
  });
});
