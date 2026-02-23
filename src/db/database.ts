import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

let db: Database.Database | null = null;

// Get the directory of this file, then resolve to project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * Get or create the SQLite database connection (singleton pattern)
 */
export function getDatabase(): Database.Database {
  if (db) {
    return db;
  }

  // Get database path from environment or use default relative to project root
  const dbPath = process.env.PELOTON_DB_PATH || path.join(PROJECT_ROOT, 'data', 'peloton.db');

  // Ensure the directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.error(`[DB] Created directory: ${dbDir}`);
  }

  // Create database connection
  db = new Database(dbPath);
  console.error(`[DB] Connected to SQLite database: ${dbPath}`);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Enable foreign key constraints
  db.pragma('foreign_keys = ON');

  // Optimize for performance
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache

  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.error('[DB] Database connection closed');
  }
}

/**
 * Execute a transaction with automatic rollback on error
 */
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  const txn = database.transaction(fn);
  return txn();
}
