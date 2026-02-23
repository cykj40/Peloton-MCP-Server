import {
  analyzeWorkoutGlucoseImpact,
  detectDelayedHypoglycemia,
  getInsightsByDiscipline,
} from '../services/correlationService.js';
import { insertGlucoseCorrelation, upsertWorkout } from '../db/queries.js';
import { makeMockGlucoseReading, makeMockWorkout } from './fixtures.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

describe('correlationService', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('analyzes workout glucose impact fields correctly', () => {
    const workoutStart = 1_700_000_000;
    const workout = makeMockWorkout({
      id: 'w-glucose',
      created_at: workoutStart,
      duration: 1800,
      fitness_discipline: 'cycling',
    });
    upsertWorkout(workout);

    const readings = [
      makeMockGlucoseReading(140, -30, workoutStart),
      makeMockGlucoseReading(130, -10, workoutStart),
      makeMockGlucoseReading(125, 0, workoutStart),
      makeMockGlucoseReading(68, 90, workoutStart),
      makeMockGlucoseReading(95, 240, workoutStart),
    ];

    const result = analyzeWorkoutGlucoseImpact(workout, readings);

    expect(result.pre_workout_glucose).toBe(132);
    expect(result.glucose_at_start).toBe(125);
    expect(result.glucose_nadir).toBe(68);
    expect(result.avg_drop).toBe(57);
    expect(result.notes).toContain('Hypoglycemia detected');
    expect(result.id).toBeDefined();
  });

  it('groups insights by discipline with risk levels', () => {
    upsertWorkout(makeMockWorkout({ id: 'a', fitness_discipline: 'cycling' }));
    upsertWorkout(makeMockWorkout({ id: 'b', fitness_discipline: 'cycling' }));
    upsertWorkout(makeMockWorkout({ id: 'c', fitness_discipline: 'yoga' }));

    insertGlucoseCorrelation({
      workout_id: 'a',
      workout_timestamp: 100,
      discipline: 'cycling',
      duration_seconds: 1800,
      pre_workout_glucose: 150,
      glucose_at_start: 140,
      glucose_nadir: 80,
      glucose_nadir_time: 60,
      glucose_4h_post: 120,
      avg_drop: 60,
      recovery_time_minutes: 50,
      notes: null,
    });
    insertGlucoseCorrelation({
      workout_id: 'b',
      workout_timestamp: 110,
      discipline: 'cycling',
      duration_seconds: 1800,
      pre_workout_glucose: 145,
      glucose_at_start: 130,
      glucose_nadir: 90,
      glucose_nadir_time: 80,
      glucose_4h_post: 125,
      avg_drop: 40,
      recovery_time_minutes: 45,
      notes: null,
    });
    insertGlucoseCorrelation({
      workout_id: 'c',
      workout_timestamp: 120,
      discipline: 'yoga',
      duration_seconds: 1800,
      pre_workout_glucose: 120,
      glucose_at_start: 115,
      glucose_nadir: 105,
      glucose_nadir_time: 30,
      glucose_4h_post: 110,
      avg_drop: 10,
      recovery_time_minutes: 20,
      notes: null,
    });

    const insights = getInsightsByDiscipline();

    const cycling = insights.find((item) => item.discipline === 'cycling');
    const yoga = insights.find((item) => item.discipline === 'yoga');
    expect(cycling).toBeDefined();
    expect(cycling?.avg_drop).toBe(50);
    expect(cycling?.risk_level).toBe('high');
    expect(yoga?.risk_level).toBe('low');
  });

  it('detects delayed hypoglycemia with severity classification', () => {
    upsertWorkout(makeMockWorkout({ id: 's1', fitness_discipline: 'running' }));
    upsertWorkout(makeMockWorkout({ id: 's2', fitness_discipline: 'running' }));
    upsertWorkout(makeMockWorkout({ id: 's3', fitness_discipline: 'running' }));

    insertGlucoseCorrelation({
      workout_id: 's1',
      workout_timestamp: 100,
      discipline: 'running',
      duration_seconds: 1800,
      pre_workout_glucose: 110,
      glucose_at_start: 108,
      glucose_nadir: 50,
      glucose_nadir_time: 80,
      glucose_4h_post: 95,
      avg_drop: 58,
      recovery_time_minutes: 100,
      notes: null,
    });
    insertGlucoseCorrelation({
      workout_id: 's2',
      workout_timestamp: 101,
      discipline: 'running',
      duration_seconds: 1800,
      pre_workout_glucose: 110,
      glucose_at_start: 108,
      glucose_nadir: 65,
      glucose_nadir_time: 200,
      glucose_4h_post: 95,
      avg_drop: 43,
      recovery_time_minutes: 100,
      notes: null,
    });
    insertGlucoseCorrelation({
      workout_id: 's3',
      workout_timestamp: 102,
      discipline: 'running',
      duration_seconds: 1800,
      pre_workout_glucose: 110,
      glucose_at_start: 108,
      glucose_nadir: 75,
      glucose_nadir_time: 130,
      glucose_4h_post: 95,
      avg_drop: 33,
      recovery_time_minutes: 100,
      notes: null,
    });

    const alerts = detectDelayedHypoglycemia();

    expect(alerts).toHaveLength(3);
    expect(alerts.find((item) => item.workout_id === 's1')?.severity).toBe('severe');
    expect(alerts.find((item) => item.workout_id === 's2')?.severity).toBe('moderate');
    expect(alerts.find((item) => item.workout_id === 's3')?.severity).toBe('mild');
    expect(alerts.find((item) => item.workout_id === 's2')?.is_delayed).toBe(true);
  });
});
