import { getDatabase } from './database.js';
import { PelotonMuscleScoresSchema } from '../schemas/muscleData.js';
import type { RideMuscleCacheEntry } from '../types/muscleData.js';

export async function getCachedRideMuscles(rideId: string): Promise<RideMuscleCacheEntry | null> {
  const result = await getDatabase().execute({
    sql: 'SELECT muscle_group_score, fetched_at FROM ride_muscle_cache WHERE ride_id = ?',
    args: [rideId],
  });
  const row = result.rows[0];
  if (!row || typeof row['muscle_group_score'] !== 'string') return null;
  const fetchedAt = row['fetched_at'];
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt < 0) return null;
  try {
    const parsed = PelotonMuscleScoresSchema.safeParse(JSON.parse(row['muscle_group_score']));
    return parsed.success ? { scores: parsed.data, fetchedAt } : null;
  } catch {
    return null;
  }
}

export async function upsertCachedRideMuscles(rideId: string, entry: RideMuscleCacheEntry): Promise<void> {
  await getDatabase().execute({
    sql: `INSERT INTO ride_muscle_cache (ride_id, muscle_group_score, fetched_at)
          VALUES (?, ?, ?)
          ON CONFLICT(ride_id) DO UPDATE SET
            muscle_group_score = excluded.muscle_group_score,
            fetched_at = excluded.fetched_at`,
    args: [rideId, JSON.stringify(entry.scores), entry.fetchedAt],
  });
}
