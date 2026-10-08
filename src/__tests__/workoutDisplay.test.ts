import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertGlucoseCorrelation, upsertWorkout } from '../db/queries.js';
import { handleWorkoutTool } from '../tools/workouts.js';
import { handleAnalyticsTool } from '../tools/analytics.js';
import { handleCorrelationTool } from '../tools/correlations.js';
import { handleMuscleActivityChart } from '../tools/muscleActivityChart.js';
import { makeMockWorkout } from './fixtures.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

const ISO = '2026-10-08T03:30:00.000Z'; // October 7, 23:30 in New York.
const SECONDS = Date.parse(ISO) / 1000;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });
async function formatter(zone?: string) {
  vi.resetModules(); vi.stubEnv('TZ', 'UTC'); vi.stubEnv('APP_TIMEZONE', zone);
  return (await import('../utils/workoutDates.js')).formatWorkoutDate;
}

describe('shared workout display formatting', () => {
  it('displays the local calendar day and time on a UTC host', async () => {
    const format = await formatter();
    expect(format(SECONDS, 'date')).toBe('2026-10-07');
    expect(format(SECONDS)).toBe('10/07/2026, 11:30:00 PM EDT');
  });
  it('crosses DST correctly, including both occurrences of a repeated hour', async () => {
    const format = await formatter();
    expect(format(Date.parse('2026-11-01T05:30:00Z') / 1000)).toBe('11/01/2026, 1:30:00 AM EDT');
    expect(format(Date.parse('2026-11-01T06:30:00Z') / 1000)).toBe('11/01/2026, 1:30:00 AM EST');
  });
  it('honors APP_TIMEZONE overrides for both day and time', async () => {
    const format = await formatter('Asia/Kathmandu');
    expect(format(SECONDS, 'date')).toBe('2026-10-08');
    expect(format(SECONDS)).toBe('10/08/2026, 9:15:00 AM GMT+5:45');
  });
  it('reports invalid timezone configuration clearly', async () => {
    const format = await formatter('Invalid/Timezone');
    expect(() => format(SECONDS)).toThrow('Invalid APP_TIMEZONE');
  });
});

describe('workout display wiring and machine timestamp preservation', () => {
  const workout = makeMockWorkout({ id: 'late-ride', created_at: SECONDS });
  const client = () => ({
    searchWorkouts: vi.fn().mockResolvedValue([workout]),
    getRecentWorkouts: vi.fn().mockResolvedValue([workout]),
    getWorkoutsInWindow: vi.fn().mockResolvedValue([workout]),
    getBodyActivity: vi.fn().mockRejectedValue(new Error('not available')),
  }) as unknown as Parameters<typeof handleAnalyticsTool>[2];

  it('localizes workout human_date and markdown while retaining ISO and epoch JSON fields', async () => {
    vi.stubEnv('TZ', 'UTC');
    const c = client();
    const json = await handleWorkoutTool('peloton_get_workouts', { response_format: 'json' }, c);
    const record = JSON.parse(json.content[0]!.text!).workouts[0];
    expect(record.human_date).toBe('10/07/2026, 11:30:00 PM EDT');
    expect(record.date).toBe(ISO); expect(record.timestamp).toBe(SECONDS);
    const markdown = await handleWorkoutTool('peloton_get_workouts', {}, c);
    expect(markdown.content[0]!.text).toContain('10/07/2026, 11:30:00 PM EDT');
    const flat = await handleWorkoutTool('peloton_get_workouts', { json_response: true }, c);
    expect(JSON.parse(flat.content[0]!.text!)[0].start_time).toBe(SECONDS);
  });
  it('localizes stats period displays while keeping structured ISO periods unchanged', async () => {
    const c = client();
    const markdown = await handleAnalyticsTool('peloton_workout_stats', {}, c);
    expect(markdown.content[0]!.text).toContain('**Period:** 2026-10-07 to 2026-10-07');
    const json = await handleAnalyticsTool('peloton_workout_stats', { response_format: 'json' }, c);
    expect(JSON.parse(json.content[0]!.text!)).toMatchObject({ period_start: ISO, period_end: ISO });
  });
  it('uses local days in the chart list and explains its display timezone', async () => {
    const result = await handleMuscleActivityChart({}, client(), { now: () => Date.parse('2026-10-08T16:00:00Z') });
    const text = result.content.find(c => c.type === 'text')!.text!;
    expect(text).toContain('- 2026-10-07 | cycling | 30 Min HIIT Ride');
    expect(text).toContain('Dates below are America/New_York');
    expect(text).not.toContain('2026-10-08T03:30');
  });
  it('localizes glucose analysis and risk alerts while preserving correlation epoch timestamps', async () => {
    vi.stubEnv('TZ', 'UTC');
    await setupTestDb();
    try {
      await upsertWorkout(workout);
      const args = {
        workout_id: workout.id,
        glucose_readings: [
          { value: 140, recordedAt: new Date((SECONDS - 600) * 1000).toISOString() },
          { value: 130, recordedAt: ISO },
          { value: 50, recordedAt: new Date((SECONDS + 3600) * 1000).toISOString() },
        ],
      };
      const markdown = await handleCorrelationTool('peloton_analyze_glucose_correlation', args, client());
      expect(markdown.content[0]!.text).toContain('10/07/2026, 11:30:00 PM EDT');
      const json = await handleCorrelationTool('peloton_analyze_glucose_correlation', { ...args, response_format: 'json' }, client());
      expect(JSON.parse(json.content[0]!.text!).workout_timestamp).toBe(SECONDS);
      // Analyze above persists a correlation; ensure the risk query has an explicit fixture too.
      await insertGlucoseCorrelation({ workout_id: workout.id, workout_timestamp: SECONDS,
        discipline: 'cycling', duration_seconds: 1800, pre_workout_glucose: 140, glucose_at_start: 130,
        glucose_nadir: 50, glucose_nadir_time: 60, glucose_4h_post: 100, avg_drop: 80,
        recovery_time_minutes: 120, notes: null });
      const alerts = await handleCorrelationTool('peloton_detect_hypoglycemia_risk', {}, client());
      expect(alerts.content[0]!.text).toContain('10/07/2026, 11:30:00 PM EDT');
      const alertJson = await handleCorrelationTool('peloton_detect_hypoglycemia_risk', { response_format: 'json' }, client());
      expect(JSON.parse(alertJson.content[0]!.text!)[0].workout_timestamp).toBe(SECONDS);
    } finally { await teardownTestDb(); }
  });
});
