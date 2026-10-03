export const PELOTON_MUSCLE_KEYS = [
  'biceps', 'calves', 'chest', 'core', 'forearms', 'glutes', 'hamstrings', 'hips',
  'lats', 'low_back', 'mid_back', 'obliques', 'quads', 'shoulders', 'traps', 'triceps',
  'other', // Catch-all for muscle keys added by Peloton.
] as const;

export type PelotonMuscleKey = (typeof PELOTON_MUSCLE_KEYS)[number];
export type MusclePercentages = Partial<Record<PelotonMuscleKey, number>>;

export interface PelotonMuscleScore {
  muscle_group: string;
  score: number;
  /** Optional API metadata is retained without constraining scoring. */
  [metadata: string]: unknown;
}

export interface MuscleData {
  percentages: MusclePercentages;
  source: 'peloton_class_data' | 'estimate';
  workoutsTotal: number;
  /** Workouts with nonzero Peloton scores, including on estimate fallback (where this is 0). */
  workoutsWithData: number;
}

export interface MuscleDataSource {
  /** Inclusive rolling window ending now; days must be an integer from 1 to 90. */
  getMuscleData(days: number): Promise<MuscleData>;
}

export interface RideMuscleCacheEntry {
  scores: PelotonMuscleScore[];
  fetchedAt: number;
}
