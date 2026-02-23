import { PelotonWorkout } from '../types/index.js';

export function makeMockWorkout(overrides?: Partial<PelotonWorkout>): PelotonWorkout {
  return {
    id: 'workout-1',
    name: '30 Min HIIT Ride',
    duration: 1800,
    created_at: Math.floor(Date.now() / 1000) - 3600,
    calories: 350,
    fitness_discipline: 'cycling',
    ride: { title: '30 Min HIIT Ride', duration: 1800 },
    ...overrides,
  };
}

export function makeMockGlucoseReading(value: number, minsOffset: number, baseTimestamp: number) {
  const ts = new Date((baseTimestamp + minsOffset * 60) * 1000).toISOString();
  return { value, recordedAt: ts };
}
