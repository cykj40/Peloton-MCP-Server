import { getDatabase } from './database.js';

/**
 * Run all database migrations
 */
export async function runMigrations(): Promise<void> {
  const db = getDatabase();

  console.error('[Migrations] Running database migrations...');

  // Create workouts table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workouts (
      id TEXT PRIMARY KEY,
      title TEXT,
      discipline TEXT NOT NULL,
      instructor_name TEXT,
      duration_seconds INTEGER,
      calories REAL,
      workout_timestamp INTEGER NOT NULL,
      output_watts REAL,
      heart_rate_avg REAL,
      raw_data TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create index on workout_timestamp for fast range queries
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_workouts_timestamp
    ON workouts(workout_timestamp)
  `);

  // Create index on discipline for filtering
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_workouts_discipline
    ON workouts(discipline)
  `);

  // Create muscle_snapshots table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS muscle_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      muscle_data TEXT NOT NULL,
      workout_count INTEGER
    )
  `);

  // Create index on period for fast lookups
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_muscle_snapshots_period
    ON muscle_snapshots(period)
  `);

  // Create glucose_correlations table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS glucose_correlations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_id TEXT NOT NULL,
      workout_timestamp INTEGER NOT NULL,
      discipline TEXT NOT NULL,
      duration_seconds INTEGER,
      pre_workout_glucose REAL,
      glucose_at_start REAL,
      glucose_nadir REAL,
      glucose_nadir_time INTEGER,
      glucose_4h_post REAL,
      avg_drop REAL,
      recovery_time_minutes INTEGER,
      notes TEXT,
      analyzed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
    )
  `);

  // Create indexes on glucose_correlations for fast queries
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_correlations_workout_id
    ON glucose_correlations(workout_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_correlations_discipline
    ON glucose_correlations(discipline)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_correlations_timestamp
    ON glucose_correlations(workout_timestamp)
  `);

  // Create auth_tokens table for the single active Peloton auth credential set.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      session_id TEXT,
      refresh_token TEXT,
      token_type TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  console.error('[Migrations] ✅ Database migrations completed');

  // Log table counts
  const workoutResult = await db.execute('SELECT COUNT(*) as count FROM workouts');
  const correlationResult = await db.execute('SELECT COUNT(*) as count FROM glucose_correlations');
  // COUNT(*) always returns exactly one row
  const workoutCount = Number(workoutResult.rows[0]!['count']);
  const correlationCount = Number(correlationResult.rows[0]!['count']);

  console.error(`[DB] Current data: ${workoutCount} workouts, ${correlationCount} correlations`);
}
