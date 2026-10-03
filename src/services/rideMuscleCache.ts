import { getCachedRideMuscles, upsertCachedRideMuscles } from '../db/muscleCache.js';
import type { PelotonMuscleScore, RideMuscleCacheEntry } from '../types/muscleData.js';

const DAY_MS = 86_400_000;
// Shared across source/cache instances. A retry retains its slot until it succeeds or fails.
let activeFetches = 0;
const waiting: Array<() => void> = [];

async function withDetailSlot<T>(fetch: () => Promise<T>): Promise<T> {
  if (activeFetches >= 4) await new Promise<void>(resolve => waiting.push(resolve));
  else activeFetches += 1;
  try {
    return await fetch();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeFetches -= 1;
  }
}

/** Turso-backed class metadata cache. Database failures never discard a successful API result. */
export class RideMuscleCache {
  private readonly memory = new Map<string, RideMuscleCacheEntry>();
  private readonly inFlight = new Map<string, Promise<PelotonMuscleScore[]>>();

  constructor(private readonly now: () => number = Date.now) {}

  get(rideId: string, fetch: () => Promise<PelotonMuscleScore[]>): Promise<PelotonMuscleScore[]> {
    const existing = this.inFlight.get(rideId);
    if (existing) return existing;
    const pending = this.load(rideId, fetch).finally(() => this.inFlight.delete(rideId));
    this.inFlight.set(rideId, pending);
    return pending;
  }

  private fresh(entry: RideMuscleCacheEntry): boolean {
    const ttl = entry.scores.some(s => s.score > 0) ? 30 * DAY_MS : DAY_MS;
    const age = this.now() - entry.fetchedAt;
    return age >= 0 && age < ttl;
  }

  private async load(rideId: string, fetch: () => Promise<PelotonMuscleScore[]>): Promise<PelotonMuscleScore[]> {
    const memory = this.memory.get(rideId);
    if (memory && this.fresh(memory)) return memory.scores;
    this.memory.delete(rideId);
    try {
      const stored = await getCachedRideMuscles(rideId);
      if (stored && this.fresh(stored)) {
        this.memory.set(rideId, stored);
        return stored.scores;
      }
    } catch {
      // Turso is optional for reads; do not log database errors or credential-bearing objects.
    }
    const scores = await withDetailSlot(fetch);
    const entry = { scores, fetchedAt: this.now() };
    this.memory.set(rideId, entry);
    try {
      await upsertCachedRideMuscles(rideId, entry);
    } catch {
      // Keep the same expiry policy in memory while Turso is unavailable.
    }
    return scores;
  }
}

export const rideMuscleCache = new RideMuscleCache();
