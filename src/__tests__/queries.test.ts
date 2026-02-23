import { getDatabase } from '../db/database.js';
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
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('upsertWorkout inserts then updates one record', () => {
    upsertWorkout(makeMockWorkout({ id: 'w1', name: 'Old Name' }));
    upsertWorkout(makeMockWorkout({ id: 'w1', name: 'New Name' }));
    expect(getWorkoutCount()).toBe(1);
    expect(getWorkoutById('w1')?.name).toBe('New Name');
  });

  it('getWorkoutsByDateRange returns workouts in range', () => {
    const base = 1_700_000_000;
    for (let i = 0; i < 5; i += 1) {
      upsertWorkout(makeMockWorkout({ id: `w-${i}`, created_at: base + i * 1000 }));
    }

    const result = getWorkoutsByDateRange(base + 1000, base + 3000);
    expect(result.map((item) => item.id)).toEqual(['w-3', 'w-2', 'w-1']);
  });

  it('getWorkoutById handles found and not found', () => {
    upsertWorkout(makeMockWorkout({ id: 'found' }));
    expect(getWorkoutById('found')?.id).toBe('found');
    expect(getWorkoutById('missing')).toBeNull();
  });

  it('getWorkoutCount increments on insert', () => {
    expect(getWorkoutCount()).toBe(0);
    upsertWorkout(makeMockWorkout({ id: 'w1' }));
    upsertWorkout(makeMockWorkout({ id: 'w2' }));
    expect(getWorkoutCount()).toBe(2);
  });

  it('getRecentWorkoutsFromDB orders newest first and respects limit', () => {
    const base = 1_700_000_000;
    upsertWorkout(makeMockWorkout({ id: 'a', created_at: base + 100 }));
    upsertWorkout(makeMockWorkout({ id: 'b', created_at: base + 300 }));
    upsertWorkout(makeMockWorkout({ id: 'c', created_at: base + 200 }));

    const result = getRecentWorkoutsFromDB(2);
    expect(result.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('getWorkoutsByDiscipline filters by discipline', () => {
    upsertWorkout(makeMockWorkout({ id: 'c1', fitness_discipline: 'cycling' }));
    upsertWorkout(makeMockWorkout({ id: 's1', fitness_discipline: 'strength' }));
    upsertWorkout(makeMockWorkout({ id: 'c2', fitness_discipline: 'cycling' }));

    const cycling = getWorkoutsByDiscipline('cycling');
    expect(cycling).toHaveLength(2);
    expect(cycling.every((item) => item.fitness_discipline === 'cycling')).toBe(true);
  });

  it('upsertMuscleSnapshot and getMuscleSnapshot round-trip and expire correctly', () => {
    upsertMuscleSnapshot('7_days', { Quadriceps: 60, Hamstrings: 40 }, 5);
    const snapshot = getMuscleSnapshot('7_days');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.workout_count).toBe(5);
    expect(snapshot?.muscle_data).toEqual({ Quadriceps: 60, Hamstrings: 40 });

    const db = getDatabase();
    db.prepare("UPDATE muscle_snapshots SET calculated_at = datetime('now', '-2 hours') WHERE period = ?").run('7_days');
    expect(getMuscleSnapshot('7_days')).toBeNull();
  });

  it('glucose correlation CRUD lifecycle works', () => {
    upsertWorkout(makeMockWorkout({ id: 'w-corr' }));

    const id = insertGlucoseCorrelation({
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

    expect(getCorrelationCount()).toBe(1);
    expect(getCorrelationsByDiscipline('cycling')).toHaveLength(1);
    expect(getAllCorrelations()).toHaveLength(1);
    expect(getCorrelationByWorkoutId('w-corr')?.id).toBe(id);

    deleteCorrelation(id);
    expect(getCorrelationCount()).toBe(0);
  });
});
