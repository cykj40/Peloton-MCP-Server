import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrations.js';

let tempDir: string | null = null;

export function setupTestDb(): void {
  closeDatabase();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peloton-mcp-test-'));
  process.env.PELOTON_DB_PATH = path.join(tempDir, 'test.db');
  runMigrations();
}

export function teardownTestDb(): void {
  closeDatabase();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
}
