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

  it('peloton_analyze_glucose_correlation markdown format shows HIGH RISK interpretation', async () => {
    const workout = makeMockWorkout({ id: 'high-risk', created_at: 1_700_000_000, duration: 1800 });
    upsertWorkout(workout);
    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool(
      'peloton_analyze_glucose_correlation',
      {
        workout_id: 'high-risk',
        glucose_readings: [
          { value: 150, recordedAt: new Date((workout.created_at - 10 * 60) * 1000).toISOString() },
          { value: 140, recordedAt: new Date(workout.created_at * 1000).toISOString() },
          { value: 80, recordedAt: new Date((workout.created_at + 60 * 60) * 1000).toISOString() },
        ],
        response_format: 'markdown',
      },
      client
    );

    expect(result.content[0]?.text).toContain('HIGH RISK');
    expect(result.content[0]?.text).toContain('significant glucose decrease');
  });

  it('peloton_analyze_glucose_correlation markdown format shows MODERATE RISK interpretation', async () => {
    const workout = makeMockWorkout({ id: 'mod-risk', created_at: 1_700_000_000, duration: 1800 });
    upsertWorkout(workout);
    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool(
      'peloton_analyze_glucose_correlation',
      {
        workout_id: 'mod-risk',
        glucose_readings: [
          { value: 130, recordedAt: new Date((workout.created_at - 10 * 60) * 1000).toISOString() },
          { value: 125, recordedAt: new Date(workout.created_at * 1000).toISOString() },
          { value: 90, recordedAt: new Date((workout.created_at + 60 * 60) * 1000).toISOString() },
        ],
        response_format: 'markdown',
      },
      client
    );

    expect(result.content[0]?.text).toContain('MODERATE RISK');
    expect(result.content[0]?.text).toContain('Monitor your glucose');
  });

  it('peloton_analyze_glucose_correlation markdown format shows DELAYED DROP warning', async () => {
    const workout = makeMockWorkout({ id: 'delayed', created_at: 1_700_000_000, duration: 1800 });
    upsertWorkout(workout);
    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool(
      'peloton_analyze_glucose_correlation',
      {
        workout_id: 'delayed',
        glucose_readings: [
          { value: 140, recordedAt: new Date((workout.created_at - 10 * 60) * 1000).toISOString() },
          { value: 135, recordedAt: new Date(workout.created_at * 1000).toISOString() },
          { value: 110, recordedAt: new Date((workout.created_at + 150 * 60) * 1000).toISOString() },
        ],
        response_format: 'markdown',
      },
      client
    );

    expect(result.content[0]?.text).toContain('DELAYED DROP');
    expect(result.content[0]?.text).toContain('hours after the workout');
  });

  it('peloton_detect_hypoglycemia_risk shows SEVERE alert for glucose < 54', async () => {
    upsertWorkout(makeMockWorkout({ id: 'severe-hypo' }));
    insertGlucoseCorrelation({
      workout_id: 'severe-hypo',
      workout_timestamp: 1_700_000_000,
      discipline: 'cycling',
      duration_seconds: 1800,
      pre_workout_glucose: 110,
      glucose_at_start: 105,
      glucose_nadir: 50,
      glucose_nadir_time: 60,
      glucose_4h_post: 90,
      avg_drop: 55,
      recovery_time_minutes: 120,
      notes: null,
    });

    const client = {
      getRecentWorkouts: vi.fn(),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool(
      'peloton_detect_hypoglycemia_risk',
      { response_format: 'markdown' },
      client
    );

    expect(result.content[0]?.text).toContain('SEVERE HYPOGLYCEMIA');
  });

  it('handleCorrelationTool returns error message when client throws error', async () => {
    const client = {
      getRecentWorkouts: vi.fn().mockRejectedValue(new Error('Network failure')),
    } as unknown as Parameters<typeof handleCorrelationTool>[2];

    const result = await handleCorrelationTool('peloton_sync_workouts', { limit: 1 }, client);

    expect(result.content[0]?.text).toContain('Error');
    expect(result.content[0]?.text).toContain('Network failure');
  });
});
