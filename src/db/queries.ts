import { getDatabase } from './database.js';
import { GlucoseCorrelation, MuscleGroupData, MuscleSnapshot, PelotonWorkout } from '../types/index.js';
import {
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

function parseCorrelationRows(rows: object[]): GlucoseCorrelation[] {
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
export async function upsertWorkout(workout: PelotonWorkout): Promise<void> {
  const db = getDatabase();
  await db.execute({
    sql: `
      INSERT OR REPLACE INTO workouts (
        id, title, discipline, instructor_name, duration_seconds,
        calories, workout_timestamp, output_watts, heart_rate_avg, raw_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      workout.id,
      workout.name || workout.ride?.title || null,
      workout.fitness_discipline,
      workout.instructor?.name || workout.ride?.instructor?.name || null,
      workout.duration,
      workout.calories || null,
      workout.created_at,
      workout.total_work || null,
      null,
      JSON.stringify(workout),
    ],
  });
}

/**
 * Get workouts by date range.
 */
export async function getWorkoutsByDateRange(
  startTimestamp: number,
  endTimestamp: number
): Promise<PelotonWorkout[]> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `
      SELECT raw_data
      FROM workouts
      WHERE workout_timestamp >= ? AND workout_timestamp <= ?
      ORDER BY workout_timestamp DESC
    `,
    args: [startTimestamp, endTimestamp],
  });

  const workouts: PelotonWorkout[] = [];
  for (const row of result.rows) {
    const rawData = row['raw_data'];
    if (typeof rawData === 'string') {
      const workout = parseWorkout(rawData);
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
export async function getWorkoutById(id: string): Promise<PelotonWorkout | null> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `SELECT raw_data FROM workouts WHERE id = ?`,
    args: [id],
  });

  const row = result.rows[0];
  if (!row) return null;
  const rawData = row['raw_data'];
  if (typeof rawData === 'string') {
    return parseWorkout(rawData);
  }
  return null;
}

/**
 * Get total workout count.
 */
export async function getWorkoutCount(): Promise<number> {
  const db = getDatabase();
  const result = await db.execute('SELECT COUNT(*) as count FROM workouts');
  // COUNT(*) always returns exactly one row
  return Number(result.rows[0]!['count']);
}

/**
 * Get recent workouts from database.
 */
export async function getRecentWorkoutsFromDB(limit = 10): Promise<PelotonWorkout[]> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `
      SELECT raw_data
      FROM workouts
      ORDER BY workout_timestamp DESC
      LIMIT ?
    `,
    args: [limit],
  });

  const workouts: PelotonWorkout[] = [];
  for (const row of result.rows) {
    const rawData = row['raw_data'];
    if (typeof rawData === 'string') {
      const workout = parseWorkout(rawData);
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
export async function getWorkoutsByDiscipline(discipline: string, limit = 50): Promise<PelotonWorkout[]> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `
      SELECT raw_data
      FROM workouts
      WHERE discipline = ?
      ORDER BY workout_timestamp DESC
      LIMIT ?
    `,
    args: [discipline, limit],
  });

  const workouts: PelotonWorkout[] = [];
  for (const row of result.rows) {
    const rawData = row['raw_data'];
    if (typeof rawData === 'string') {
      const workout = parseWorkout(rawData);
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
export async function upsertMuscleSnapshot(
  period: '7_days' | '30_days' | '90_days',
  muscleData: MuscleGroupData,
  workoutCount: number
): Promise<void> {
  const db = getDatabase();
  await db.execute({ sql: 'DELETE FROM muscle_snapshots WHERE period = ?', args: [period] });
  await db.execute({
    sql: `INSERT INTO muscle_snapshots (period, calculated_at, muscle_data, workout_count)
          VALUES (?, datetime('now'), ?, ?)`,
    args: [period, JSON.stringify(muscleData), workoutCount],
  });
}

/**
 * Get muscle snapshot for a period (returns null if older than 1 hour).
 */
export async function getMuscleSnapshot(period: '7_days' | '30_days' | '90_days'): Promise<MuscleSnapshot | null> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `
      SELECT id, period, calculated_at, muscle_data, workout_count
      FROM muscle_snapshots
      WHERE period = ?
      ORDER BY calculated_at DESC
      LIMIT 1
    `,
    args: [period],
  });

  const row = result.rows[0];
  if (!row) return null;

  // Check expiry in JS
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC without Z suffix).
  // Replace the space with T and append Z so Date() parses it as UTC.
  const calculatedAtStr = String(row['calculated_at']).replace(' ', 'T') + 'Z';
  const calculatedAt = new Date(calculatedAtStr);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (calculatedAt < oneHourAgo) return null;

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
export async function insertGlucoseCorrelation(correlation: GlucoseCorrelation): Promise<number> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `
      INSERT INTO glucose_correlations (
        workout_id, workout_timestamp, discipline, duration_seconds,
        pre_workout_glucose, glucose_at_start, glucose_nadir, glucose_nadir_time,
        glucose_4h_post, avg_drop, recovery_time_minutes, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
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
      correlation.notes,
    ],
  });

  return Number(result.lastInsertRowid);
}

/**
 * Get correlations by discipline.
 */
export async function getCorrelationsByDiscipline(discipline: string): Promise<GlucoseCorrelation[]> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `SELECT * FROM glucose_correlations WHERE discipline = ? ORDER BY workout_timestamp DESC`,
    args: [discipline],
  });
  return parseCorrelationRows(result.rows);
}

/**
 * Get all correlations with optional limit.
 */
export async function getAllCorrelations(limit?: number): Promise<GlucoseCorrelation[]> {
  const db = getDatabase();
  let result;
  if (limit !== undefined) {
    result = await db.execute({
      sql: 'SELECT * FROM glucose_correlations ORDER BY workout_timestamp DESC LIMIT ?',
      args: [limit],
    });
  } else {
    result = await db.execute('SELECT * FROM glucose_correlations ORDER BY workout_timestamp DESC');
  }
  return parseCorrelationRows(result.rows);
}

/**
 * Get correlation by workout ID.
 */
export async function getCorrelationByWorkoutId(workoutId: string): Promise<GlucoseCorrelation | null> {
  const db = getDatabase();
  const result = await db.execute({
    sql: `SELECT * FROM glucose_correlations WHERE workout_id = ? LIMIT 1`,
    args: [workoutId],
  });

  const row = result.rows[0];
  if (!row) return null;

  const parsed = GlucoseCorrelationSchema.safeParse(row);
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
export async function deleteCorrelation(id: number): Promise<void> {
  const db = getDatabase();
  await db.execute({ sql: 'DELETE FROM glucose_correlations WHERE id = ?', args: [id] });
}

/**
 * Get correlation count.
 */
export async function getCorrelationCount(): Promise<number> {
  const db = getDatabase();
  const result = await db.execute('SELECT COUNT(*) as count FROM glucose_correlations');
  // COUNT(*) always returns exactly one row
  return Number(result.rows[0]!['count']);
}
