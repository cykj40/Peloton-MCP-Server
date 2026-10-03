import { PELOTON_MUSCLE_KEYS } from '../types/muscleData.js';
import type { MusclePercentages, PelotonMuscleKey } from '../types/muscleData.js';
import type { MuscleImpactData } from '../types/index.js';

/** Compatibility aliases for the legacy estimate, not a chart-region mapping.
 * Its broad back/upper_back categories are approximated as mid_back. No score is invented.
 */
const ESTIMATE_ALIASES: Readonly<Record<string, PelotonMuscleKey>> = {
  quadriceps: 'quads', lower_back: 'low_back', back: 'mid_back', upper_back: 'mid_back',
};

export function impactToPelotonPercentages(impact: MuscleImpactData): MusclePercentages {
  const total = Object.values(impact).reduce((sum, entry) => sum + entry.score, 0);
  const percentages: MusclePercentages = {};
  if (total <= 0) return percentages;
  for (const [key, entry] of Object.entries(impact)) {
    const muscle = ESTIMATE_ALIASES[key] ?? PELOTON_MUSCLE_KEYS.find(k => k === key);
    if (muscle) percentages[muscle] = (percentages[muscle] ?? 0) + 100 * entry.score / total;
  }
  return percentages;
}

