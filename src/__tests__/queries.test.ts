import { closeDatabase, getDatabase } from '../db/database.js';
import {
  deleteCorrelation,
  getAllCorrelations,
  getCorrelationByWorkoutId,
  getCorrelationCount,
  getCorrelationsByDiscipline,
  getMuscleSnapshot,
  getRecentWorkoutsFromDB,
  getWorkoutById,
  getWorkoutCount,
  getWorkoutsByDateRange,
  getWorkoutsByDiscipline,
  insertGlucoseCorrelation,
  upsertMuscleSnapshot,
  upsertWorkout,
} from '../db/queries.js';
import { makeMockWorkout } from './fixtures.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

describe('db queries', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('upsertWorkout inserts then updates one record', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'w1', name: 'Old Name' }));
    await upsertWorkout(makeMockWorkout({ id: 'w1', name: 'New Name' }));
    expect(await getWorkoutCount()).toBe(1);
    expect((await getWorkoutById('w1'))?.name).toBe('New Name');
  });

  it('getWorkoutsByDateRange returns workouts in range', async () => {
    const base = 1_700_000_000;
    for (let i = 0; i < 5; i += 1) {
      await upsertWorkout(makeMockWorkout({ id: `w-${i}`, created_at: base + i * 1000 }));
    }

    const result = await getWorkoutsByDateRange(base + 1000, base + 3000);
    expect(result.map((item) => item.id)).toEqual(['w-3', 'w-2', 'w-1']);
  });

  it('getWorkoutById handles found and not found', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'found' }));
    expect((await getWorkoutById('found'))?.id).toBe('found');
    expect(await getWorkoutById('missing')).toBeNull();
  });

  it('getWorkoutCount increments on insert', async () => {
    expect(await getWorkoutCount()).toBe(0);
    await upsertWorkout(makeMockWorkout({ id: 'w1' }));
    await upsertWorkout(makeMockWorkout({ id: 'w2' }));
    expect(await getWorkoutCount()).toBe(2);
  });

  it('getRecentWorkoutsFromDB orders newest first and respects limit', async () => {
    const base = 1_700_000_000;
    await upsertWorkout(makeMockWorkout({ id: 'a', created_at: base + 100 }));
    await upsertWorkout(makeMockWorkout({ id: 'b', created_at: base + 300 }));
    await upsertWorkout(makeMockWorkout({ id: 'c', created_at: base + 200 }));

    const result = await getRecentWorkoutsFromDB(2);
    expect(result.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('getWorkoutsByDiscipline filters by discipline', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'c1', fitness_discipline: 'cycling' }));
    await upsertWorkout(makeMockWorkout({ id: 's1', fitness_discipline: 'strength' }));
    await upsertWorkout(makeMockWorkout({ id: 'c2', fitness_discipline: 'cycling' }));

    const cycling = await getWorkoutsByDiscipline('cycling');
    expect(cycling).toHaveLength(2);
    expect(cycling.every((item) => item.fitness_discipline === 'cycling')).toBe(true);
  });

  it('upsertMuscleSnapshot and getMuscleSnapshot round-trip and expire correctly', async () => {
    await upsertMuscleSnapshot('7_days', { Quadriceps: 60, Hamstrings: 40 }, 5);
    const snapshot = await getMuscleSnapshot('7_days');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.workout_count).toBe(5);
    expect(snapshot?.muscle_data).toEqual({ Quadriceps: 60, Hamstrings: 40 });

    const db = getDatabase();
    await db.execute({
      sql: "UPDATE muscle_snapshots SET calculated_at = datetime('now', '-2 hours') WHERE period = ?",
      args: ['7_days'],
    });
    expect(await getMuscleSnapshot('7_days')).toBeNull();
  });

  it('glucose correlation CRUD lifecycle works', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'w-corr' }));

    const id = await insertGlucoseCorrelation({
      workout_id: 'w-corr',
      workout_timestamp: 1_700_000_000,
      discipline: 'cycling',
      duration_seconds: 1800,
      pre_workout_glucose: 120,
      glucose_at_start: 115,
      glucose_nadir: 85,
      glucose_nadir_time: 90,
      glucose_4h_post: 110,
      avg_drop: 30,
      recovery_time_minutes: 45,
      notes: null,
    });

    expect(await getCorrelationCount()).toBe(1);
    expect(await getCorrelationsByDiscipline('cycling')).toHaveLength(1);
    expect(await getAllCorrelations()).toHaveLength(1);
    expect((await getCorrelationByWorkoutId('w-corr'))?.id).toBe(id);

    await deleteCorrelation(id);
    expect(await getCorrelationCount()).toBe(0);
  });

  it('getWorkoutById returns null when raw_data is malformed JSON', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'bad-json' }));
    const db = getDatabase();
    await db.execute({
      sql: 'UPDATE workouts SET raw_data = ? WHERE id = ?',
      args: ['{invalid json}', 'bad-json'],
    });
    expect(await getWorkoutById('bad-json')).toBeNull();
  });

  it('getWorkoutById returns null when raw_data fails schema validation', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'bad-schema' }));
    const db = getDatabase();
    const invalidData = JSON.stringify({ id: 'w1', missing_required_fields: true });
    await db.execute({
      sql: 'UPDATE workouts SET raw_data = ? WHERE id = ?',
      args: [invalidData, 'bad-schema'],
    });
    expect(await getWorkoutById('bad-schema')).toBeNull();
  });

  it('getWorkoutsByDateRange skips workouts with invalid raw_data', async () => {
    const base = 1_700_000_000;
    await upsertWorkout(makeMockWorkout({ id: 'valid', created_at: base }));
    await upsertWorkout(makeMockWorkout({ id: 'invalid', created_at: base + 100 }));

    const db = getDatabase();
    await db.execute({
      sql: 'UPDATE workouts SET raw_data = ? WHERE id = ?',
      args: ['{bad json}', 'invalid'],
    });

    const result = await getWorkoutsByDateRange(base - 100, base + 200);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('valid');
  });

  it('getMuscleSnapshot returns null when muscle_data contains non-number values', async () => {
    const db = getDatabase();
    await db.execute({
      sql: `INSERT INTO muscle_snapshots (period, calculated_at, muscle_data, workout_count)
            VALUES (?, datetime('now'), ?, ?)`,
      args: ['7_days', JSON.stringify({ Quadriceps: 'not-a-number' }), 5],
    });

    expect(await getMuscleSnapshot('7_days')).toBeNull();
  });

  it('getMuscleSnapshot returns null when muscle_data is not an object', async () => {
    const db = getDatabase();
    await db.execute({
      sql: `INSERT INTO muscle_snapshots (period, calculated_at, muscle_data, workout_count)
            VALUES (?, datetime('now'), ?, ?)`,
      args: ['30_days', JSON.stringify('not-an-object'), 5],
    });

    expect(await getMuscleSnapshot('30_days')).toBeNull();
  });

  it('getRecentWorkoutsFromDB skips workouts with invalid raw_data', async () => {
    const base = 1_700_000_000;
    await upsertWorkout(makeMockWorkout({ id: 'valid', created_at: base }));
    await upsertWorkout(makeMockWorkout({ id: 'invalid', created_at: base + 100 }));

    const db = getDatabase();
    await db.execute({
      sql: 'UPDATE workouts SET raw_data = ? WHERE id = ?',
      args: ['{bad json}', 'invalid'],
    });

    const result = await getRecentWorkoutsFromDB(10);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('valid');
  });

  it('getAllCorrelations respects limit parameter', async () => {
    for (let i = 0; i < 5; i += 1) {
      await upsertWorkout(makeMockWorkout({ id: `w-${i}` }));
    }

    for (let i = 0; i < 5; i += 1) {
      await insertGlucoseCorrelation({
        workout_id: `w-${i}`,
        workout_timestamp: 1_700_000_000 + i,
        discipline: 'cycling',
        duration_seconds: 1800,
        pre_workout_glucose: 120,
        glucose_at_start: 115,
        glucose_nadir: 85,
        glucose_nadir_time: 90,
        glucose_4h_post: 110,
        avg_drop: 30,
        recovery_time_minutes: 45,
        notes: null,
      });
    }

    expect(await getAllCorrelations(3)).toHaveLength(3);
    expect(await getAllCorrelations()).toHaveLength(5);
  });

  it('getWorkoutById returns null when raw_data column is NULL', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'null-raw' }));
    const db = getDatabase();
    await db.execute({
      sql: 'UPDATE workouts SET raw_data = NULL WHERE id = ?',
      args: ['null-raw'],
    });
    expect(await getWorkoutById('null-raw')).toBeNull();
  });

  it('getMuscleSnapshot returns null when schema validation fails (null workout_count)', async () => {
    const db = getDatabase();
    // Insert with NULL workout_count — fails MuscleSnapshotRowSchema (workout_count: z.number())
    await db.execute({
      sql: `INSERT INTO muscle_snapshots (period, calculated_at, muscle_data, workout_count)
            VALUES (?, datetime('now'), ?, NULL)`,
      args: ['7_days', JSON.stringify({ Q: 60 })],
    });
    expect(await getMuscleSnapshot('7_days')).toBeNull();
  });

  it('getCorrelationByWorkoutId returns null when schema validation fails', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'schema-fail' }));
    const db = getDatabase();
    // Insert with NULL duration_seconds — fails GlucoseCorrelationSchema (duration_seconds: z.number())
    await db.execute({
      sql: `INSERT INTO glucose_correlations
            (workout_id, workout_timestamp, discipline, duration_seconds, pre_workout_glucose,
             glucose_at_start, glucose_nadir, glucose_nadir_time, glucose_4h_post,
             avg_drop, recovery_time_minutes, notes)
            VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      args: ['schema-fail', 1_700_000_000, 'cycling'],
    });
    expect(await getCorrelationByWorkoutId('schema-fail')).toBeNull();
  });

  it('getRecentWorkoutsFromDB skips workouts with null raw_data column', async () => {
    const base = 1_700_000_000;
    await upsertWorkout(makeMockWorkout({ id: 'valid2', created_at: base }));
    await upsertWorkout(makeMockWorkout({ id: 'null-raw2', created_at: base + 100 }));

    const db = getDatabase();
    await db.execute({
      sql: 'UPDATE workouts SET raw_data = NULL WHERE id = ?',
      args: ['null-raw2'],
    });

    const result = await getRecentWorkoutsFromDB(10);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('valid2');
  });

  it('getDatabase throws when DATABASE_URL is not set', async () => {
    await closeDatabase();
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => getDatabase()).toThrow('DATABASE_URL environment variable is required');
    } finally {
      process.env.DATABASE_URL = savedUrl;
      await closeDatabase();
      // Restore DB for teardown
      process.env.DATABASE_URL = 'file::memory:';
    }
  });

  it('getDatabase uses TURSO_AUTH_TOKEN when set', async () => {
    await closeDatabase();
    const savedToken = process.env.TURSO_AUTH_TOKEN;
    // file: URLs ignore authToken but the branch in createClient({ url, authToken }) still executes
    process.env.TURSO_AUTH_TOKEN = 'fake-token-for-branch-coverage';
    try {
      const db = getDatabase();
      expect(db).toBeDefined();
    } finally {
      process.env.TURSO_AUTH_TOKEN = savedToken;
      await closeDatabase();
      // Restore for teardown
      process.env.DATABASE_URL = 'file::memory:';
    }
  });

  it('getCorrelationByWorkoutId returns null when no matching correlation exists', async () => {
    // No correlation inserted for this workout_id — should return null (covers the !row branch)
    expect(await getCorrelationByWorkoutId('no-correlation-here')).toBeNull();
  });

  it('getMuscleSnapshot returns null when no snapshot exists for the period', async () => {
    // No snapshot inserted — covers the !row branch at line 268
    expect(await getMuscleSnapshot('90_days')).toBeNull();
  });

  it('getWorkoutsByDiscipline skips workouts with null raw_data', async () => {
    await upsertWorkout(makeMockWorkout({ id: 'disc-valid', fitness_discipline: 'cycling' }));
    await upsertWorkout(makeMockWorkout({ id: 'disc-null', fitness_discipline: 'cycling' }));

    const db = getDatabase();
    await db.execute({
      sql: 'UPDATE workouts SET raw_data = NULL WHERE id = ?',
      args: ['disc-null'],
    });

    const result = await getWorkoutsByDiscipline('cycling');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('disc-valid');
  });
});
