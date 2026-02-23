import { getDatabase } from './database.js';
import { PelotonWorkout, GlucoseCorrelation, MuscleSnapshot, MuscleGroupData } from '../types/index.js';

// ─── Workout Queries ─────────────────────────────────────────────────────────

/**
 * Insert or update a workout in the database
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
    null, // heart_rate_avg not in current API response
    JSON.stringify(workout)
  );
}

/**
 * Get workouts by date range
 */
export function getWorkoutsByDateRange(
  startTimestamp: number,
  endTimestamp: number
): PelotonWorkout[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    WHERE workout_timestamp >= ? AND workout_timestamp <= ?
    ORDER BY workout_timestamp DESC
  `);

  const rows = stmt.all(startTimestamp, endTimestamp) as { raw_data: string }[];

  return rows.map((row) => JSON.parse(row.raw_data) as PelotonWorkout);
}

/**
 * Get workout by ID
 */
export function getWorkoutById(id: string): PelotonWorkout | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    WHERE id = ?
  `);

  const row = stmt.get(id) as { raw_data: string } | undefined;

  return row ? (JSON.parse(row.raw_data) as PelotonWorkout) : null;
}

/**
 * Get total workout count
 */
export function getWorkoutCount(): number {
  const db = getDatabase();

  const result = db.prepare('SELECT COUNT(*) as count FROM workouts').get() as { count: number };

  return result.count;
}

/**
 * Get recent workouts from database
 */
export function getRecentWorkoutsFromDB(limit: number = 10): PelotonWorkout[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    ORDER BY workout_timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(limit) as { raw_data: string }[];

  return rows.map((row) => JSON.parse(row.raw_data) as PelotonWorkout);
}

/**
 * Get workouts by discipline
 */
export function getWorkoutsByDiscipline(discipline: string, limit: number = 50): PelotonWorkout[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT raw_data
    FROM workouts
    WHERE discipline = ?
    ORDER BY workout_timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(discipline, limit) as { raw_data: string }[];

  return rows.map((row) => JSON.parse(row.raw_data) as PelotonWorkout);
}

// ─── Muscle Snapshot Queries ─────────────────────────────────────────────────

/**
 * Insert or update muscle snapshot for a period
 */
export function upsertMuscleSnapshot(
  period: '7_days' | '30_days' | '90_days',
  muscleData: MuscleGroupData,
  workoutCount: number
): void {
  const db = getDatabase();

  // Delete old snapshots for this period
  db.prepare('DELETE FROM muscle_snapshots WHERE period = ?').run(period);

  // Insert new snapshot
  const stmt = db.prepare(`
    INSERT INTO muscle_snapshots (period, calculated_at, muscle_data, workout_count)
    VALUES (?, datetime('now'), ?, ?)
  `);

  stmt.run(period, JSON.stringify(muscleData), workoutCount);
}

/**
 * Get muscle snapshot for a period (returns null if older than 1 hour)
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

  const row = stmt.get(period) as {
    id: number;
    period: string;
    calculated_at: string;
    muscle_data: string;
    workout_count: number;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    period: row.period as '7_days' | '30_days' | '90_days',
    calculated_at: row.calculated_at,
    muscle_data: JSON.parse(row.muscle_data),
    workout_count: row.workout_count,
  };
}

// ─── Glucose Correlation Queries ─────────────────────────────────────────────

/**
 * Insert a glucose correlation
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

  return result.lastInsertRowid as number;
}

/**
 * Get correlations by discipline
 */
export function getCorrelationsByDiscipline(discipline: string): GlucoseCorrelation[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM glucose_correlations
    WHERE discipline = ?
    ORDER BY workout_timestamp DESC
  `);

  return stmt.all(discipline) as GlucoseCorrelation[];
}

/**
 * Get all correlations with optional limit
 */
export function getAllCorrelations(limit?: number): GlucoseCorrelation[] {
  const db = getDatabase();

  let query = 'SELECT * FROM glucose_correlations ORDER BY workout_timestamp DESC';

  if (limit) {
    query += ` LIMIT ${limit}`;
  }

  const stmt = db.prepare(query);

  return stmt.all() as GlucoseCorrelation[];
}

/**
 * Get correlation by workout ID
 */
export function getCorrelationByWorkoutId(workoutId: string): GlucoseCorrelation | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM glucose_correlations
    WHERE workout_id = ?
    LIMIT 1
  `);

  const result = stmt.get(workoutId) as GlucoseCorrelation | undefined;

  return result || null;
}

/**
 * Delete a correlation
 */
export function deleteCorrelation(id: number): void {
  const db = getDatabase();

  db.prepare('DELETE FROM glucose_correlations WHERE id = ?').run(id);
}

/**
 * Get correlation count
 */
export function getCorrelationCount(): number {
  const db = getDatabase();

  const result = db.prepare('SELECT COUNT(*) as count FROM glucose_correlations').get() as {
    count: number;
  };

  return result.count;
}
