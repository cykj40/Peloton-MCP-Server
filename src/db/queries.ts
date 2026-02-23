import { getDatabase } from './database.js';
import { GlucoseCorrelation, MuscleGroupData, MuscleSnapshot, PelotonWorkout } from '../types/index.js';
import {
  CountRowSchema,
  GlucoseCorrelationSchema,
  MuscleSnapshotRowSchema,
  StoredPelotonWorkoutSchema,
} from '../schemas/db.js';
import { isError } from '../types/errors.js';

function parseWorkout(rawData: string): PelotonWorkout | null {
  try {
    const parsedJson: unknown = JSON.parse(rawData);
    const parsedWorkout = StoredPelotonWorkoutSchema.safeParse(parsedJson);
    if (!parsedWorkout.success) {
      console.error('[DB] Invalid stored workout JSON:', parsedWorkout.error.message);
      return null;
    }
    const workout = parsedWorkout.data;
    const ride = workout.ride
      ? {
          title: workout.ride.title,
          duration: workout.ride.duration,
          ...(workout.ride.instructor ? { instructor: workout.ride.instructor } : {}),
        }
      : undefined;

    return {
      id: workout.id,
      name: workout.name,
      duration: workout.duration,
      created_at: workout.created_at,
      calories: workout.calories,
      fitness_discipline: workout.fitness_discipline,
      ...(workout.instructor ? { instructor: workout.instructor } : {}),
      ...(workout.total_work !== undefined ? { total_work: workout.total_work } : {}),
      ...(workout.device_type !== undefined ? { device_type: workout.device_type } : {}),
      ...(workout.status !== undefined ? { status: workout.status } : {}),
      ...(ride ? { ride } : {}),
    };
  } catch (error: unknown) {
    console.error('[DB] Failed to parse workout JSON:', isError(error) ? error.message : 'Unknown error');
    return null;
  }
}

function parseCorrelationRows(rows: unknown[]): GlucoseCorrelation[] {
  const correlations: GlucoseCorrelation[] = [];
  for (const row of rows) {
    const parsed = GlucoseCorrelationSchema.safeParse(row);
    if (parsed.success) {
      const correlation = parsed.data;
      correlations.push({
        workout_id: correlation.workout_id,
        workout_timestamp: correlation.workout_timestamp,
        discipline: correlation.discipline,
        duration_seconds: correlation.duration_seconds,
        pre_workout_glucose: correlation.pre_workout_glucose,
        glucose_at_start: correlation.glucose_at_start,
        glucose_nadir: correlation.glucose_nadir,
        glucose_nadir_time: correlation.glucose_nadir_time,
        glucose_4h_post: correlation.glucose_4h_post,
        avg_drop: correlation.avg_drop,
        recovery_time_minutes: correlation.recovery_time_minutes,
        notes: correlation.notes,
        ...(correlation.id !== undefined ? { id: correlation.id } : {}),
        ...(correlation.analyzed_at !== undefined ? { analyzed_at: correlation.analyzed_at } : {}),
      });
    }
  }
  return correlations;
}

function readCount(row: unknown): number {
  const parsed = CountRowSchema.safeParse(row);
  return parsed.success ? parsed.data.count : 0;
}

function parseMuscleGroupData(value: unknown): MuscleGroupData | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const result: MuscleGroupData = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'number') {
      return null;
    }
    result[key] = item;
  }

  return result;
}

/**
 * Insert or update a workout in the database.
 */
export function upsertWorkout(workout: PelotonWorkout): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO workouts (
      id, title, discipline, instructor_name, duration_seconds,
      calories, workout_timestamp, output_watts, heart_rate_avg, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    workout.id,
    workout.name || workout.ride?.title || null,
    workout.fitness_discipline,
    workout.instructor?.name || workout.ride?.instructor?.name || null,
    workout.duration,
    workout.calories || null,
    workout.created_at,
    workout.total_work || null,
    null,
    JSON.stringify(workout)
  );
}

/**
 * Get workouts by date range.
 */
export function getWorkoutsByDateRange(startTimestamp: number, endTimestamp: number): PelotonWorkout[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    WHERE workout_timestamp >= ? AND workout_timestamp <= ?
    ORDER BY workout_timestamp DESC
  `);

  const rows = stmt.all(startTimestamp, endTimestamp);
  const workouts: PelotonWorkout[] = [];
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && 'raw_data' in row && typeof row.raw_data === 'string') {
      const workout = parseWorkout(row.raw_data);
      if (workout) {
        workouts.push(workout);
      }
    }
  }
  return workouts;
}

/**
 * Get workout by ID.
 */
export function getWorkoutById(id: string): PelotonWorkout | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    WHERE id = ?
  `);

  const row = stmt.get(id);
  if (typeof row === 'object' && row !== null && 'raw_data' in row && typeof row.raw_data === 'string') {
    return parseWorkout(row.raw_data);
  }
  return null;
}

/**
 * Get total workout count.
 */
export function getWorkoutCount(): number {
  const db = getDatabase();
  const result = db.prepare('SELECT COUNT(*) as count FROM workouts').get();
  return readCount(result);
}

/**
 * Get recent workouts from database.
 */
export function getRecentWorkoutsFromDB(limit = 10): PelotonWorkout[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    ORDER BY workout_timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(limit);
  const workouts: PelotonWorkout[] = [];
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && 'raw_data' in row && typeof row.raw_data === 'string') {
      const workout = parseWorkout(row.raw_data);
      if (workout) {
        workouts.push(workout);
      }
    }
  }
  return workouts;
}

/**
 * Get workouts by discipline.
 */
export function getWorkoutsByDiscipline(discipline: string, limit = 50): PelotonWorkout[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    WHERE discipline = ?
    ORDER BY workout_timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(discipline, limit);
  const workouts: PelotonWorkout[] = [];
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && 'raw_data' in row && typeof row.raw_data === 'string') {
      const workout = parseWorkout(row.raw_data);
      if (workout) {
        workouts.push(workout);
      }
    }
  }
  return workouts;
}

/**
 * Insert or update muscle snapshot for a period.
 */
export function upsertMuscleSnapshot(
  period: '7_days' | '30_days' | '90_days',
  muscleData: MuscleGroupData,
  workoutCount: number
): void {
  const db = getDatabase();
  db.prepare('DELETE FROM muscle_snapshots WHERE period = ?').run(period);
  const stmt = db.prepare(`
    INSERT INTO muscle_snapshots (period, calculated_at, muscle_data, workout_count)
    VALUES (?, datetime('now'), ?, ?)
  `);
  stmt.run(period, JSON.stringify(muscleData), workoutCount);
}

/**
 * Get muscle snapshot for a period (returns null if older than 1 hour).
 */
export function getMuscleSnapshot(period: '7_days' | '30_days' | '90_days'): MuscleSnapshot | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, period, calculated_at, muscle_data, workout_count
    FROM muscle_snapshots
    WHERE period = ?
    AND datetime(calculated_at) > datetime('now', '-1 hour')
    ORDER BY calculated_at DESC
    LIMIT 1
  `);

  const row = stmt.get(period);
  const parsedRow = MuscleSnapshotRowSchema.safeParse(row);
  if (!parsedRow.success) {
    return null;
  }

  const muscleDataJson: unknown = JSON.parse(parsedRow.data.muscle_data);
  const muscleData = parseMuscleGroupData(muscleDataJson);
  if (!muscleData) {
    return null;
  }

  return {
    id: parsedRow.data.id,
    period: parsedRow.data.period,
    calculated_at: parsedRow.data.calculated_at,
    muscle_data: muscleData,
    workout_count: parsedRow.data.workout_count,
  };
}

/**
 * Insert a glucose correlation.
 */
export function insertGlucoseCorrelation(correlation: GlucoseCorrelation): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO glucose_correlations (
      workout_id, workout_timestamp, discipline, duration_seconds,
      pre_workout_glucose, glucose_at_start, glucose_nadir, glucose_nadir_time,
      glucose_4h_post, avg_drop, recovery_time_minutes, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    correlation.workout_id,
    correlation.workout_timestamp,
    correlation.discipline,
    correlation.duration_seconds,
    correlation.pre_workout_glucose,
    correlation.glucose_at_start,
    correlation.glucose_nadir,
    correlation.glucose_nadir_time,
    correlation.glucose_4h_post,
    correlation.avg_drop,
    correlation.recovery_time_minutes,
    correlation.notes
  );

  if (typeof result.lastInsertRowid === 'bigint') {
    return Number(result.lastInsertRowid);
  }

  return result.lastInsertRowid;
}

/**
 * Get correlations by discipline.
 */
export function getCorrelationsByDiscipline(discipline: string): GlucoseCorrelation[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM glucose_correlations
    WHERE discipline = ?
    ORDER BY workout_timestamp DESC
  `);
  const rows = stmt.all(discipline);
  return parseCorrelationRows(rows);
}

/**
 * Get all correlations with optional limit.
 */
export function getAllCorrelations(limit?: number): GlucoseCorrelation[] {
  const db = getDatabase();
  let query = 'SELECT * FROM glucose_correlations ORDER BY workout_timestamp DESC';
  if (limit) {
    query += ` LIMIT ${limit}`;
  }
  const stmt = db.prepare(query);
  const rows = stmt.all();
  return parseCorrelationRows(rows);
}

/**
 * Get correlation by workout ID.
 */
export function getCorrelationByWorkoutId(workoutId: string): GlucoseCorrelation | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM glucose_correlations
    WHERE workout_id = ?
    LIMIT 1
  `);

  const result = stmt.get(workoutId);
  const parsed = GlucoseCorrelationSchema.safeParse(result);
  if (!parsed.success) {
    return null;
  }

  const correlation = parsed.data;
  return {
    workout_id: correlation.workout_id,
    workout_timestamp: correlation.workout_timestamp,
    discipline: correlation.discipline,
    duration_seconds: correlation.duration_seconds,
    pre_workout_glucose: correlation.pre_workout_glucose,
    glucose_at_start: correlation.glucose_at_start,
    glucose_nadir: correlation.glucose_nadir,
    glucose_nadir_time: correlation.glucose_nadir_time,
    glucose_4h_post: correlation.glucose_4h_post,
    avg_drop: correlation.avg_drop,
    recovery_time_minutes: correlation.recovery_time_minutes,
    notes: correlation.notes,
    ...(correlation.id !== undefined ? { id: correlation.id } : {}),
    ...(correlation.analyzed_at !== undefined ? { analyzed_at: correlation.analyzed_at } : {}),
  };
}

/**
 * Delete a correlation.
 */
export function deleteCorrelation(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM glucose_correlations WHERE id = ?').run(id);
}

/**
 * Get correlation count.
 */
export function getCorrelationCount(): number {
  const db = getDatabase();
  const result = db.prepare('SELECT COUNT(*) as count FROM glucose_correlations').get();
  return readCount(result);
}
