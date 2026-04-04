import { createClient, Client } from '@libsql/client';

let client: Client | null = null;

/**
 * Get or create the libSQL database client (singleton pattern)
 */
export function getDatabase(): Client {
  if (client) {
    return client;
  }

  const url = process.env.DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  client = createClient({ url, ...(authToken ? { authToken } : {}) });
  console.error('[DB] Connected to Turso database:', url);
  return client;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (client) {
    client.close();
    client = null;
    console.error('[DB] Database connection closed');
  }
}
