import { getDatabase } from './database.js';

/**
 * Run all database migrations
 */
export function runMigrations(): void {
  const db = getDatabase();

  console.error('[Migrations] Running database migrations...');

  // Create workouts table
  db.exec(`
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workouts_timestamp
    ON workouts(workout_timestamp)
  `);

  // Create index on discipline for filtering
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workouts_discipline
    ON workouts(discipline)
  `);

  // Create muscle_snapshots table
  db.exec(`
    CREATE TABLE IF NOT EXISTS muscle_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      muscle_data TEXT NOT NULL,
      workout_count INTEGER
    )
  `);

  // Create index on period for fast lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_muscle_snapshots_period
    ON muscle_snapshots(period)
  `);

  // Create glucose_correlations table
  db.exec(`
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_correlations_workout_id
    ON glucose_correlations(workout_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_correlations_discipline
    ON glucose_correlations(discipline)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_correlations_timestamp
    ON glucose_correlations(workout_timestamp)
  `);

  console.error('[Migrations] ✅ Database migrations completed');

  // Log table counts
  const workoutCount = db.prepare('SELECT COUNT(*) as count FROM workouts').get() as { count: number };
  const correlationCount = db.prepare('SELECT COUNT(*) as count FROM glucose_correlations').get() as { count: number };

  console.error(`[DB] Current data: ${workoutCount.count} workouts, ${correlationCount.count} correlations`);
}
