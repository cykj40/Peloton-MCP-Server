import { closeDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';

export async function setupTestDb(): Promise<void> {
  await closeDatabase();
  process.env.DATABASE_URL = 'file::memory:';
  delete process.env.TURSO_AUTH_TOKEN;
  await runMigrations();
}

export async function teardownTestDb(): Promise<void> {
  await closeDatabase();
}
