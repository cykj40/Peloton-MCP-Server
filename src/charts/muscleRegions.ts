import type { MuscleImpactData } from '../types/index.js';
import type { PelotonMuscleKey } from '../types/muscleData.js';
import { impactToPelotonPercentages } from '../services/musclePercentages.js';

/** Pure Peloton-key-to-region data and classification; no drawing geometry lives here. */

export type MuscleState = 'worked' | 'neutral' | 'attention';

export type RegionId =
  | 'shoulders'
  | 'chest'
  | 'biceps'
  | 'forearms'
  | 'hips'
  | 'core'
  | 'quads'
  | 'upper_back'
  | 'triceps'
  | 'lower_back'
  | 'glutes'
  | 'hamstrings'
  | 'calves';

export interface RegionDef {
  id: RegionId;
  label: string;
  /** Raw muscle keys summed into this region; keys with no data count as 0%. */
  sourceKeys: readonly PelotonMuscleKey[];
}

/** All 16 Peloton muscles map exactly once; synthetic `other` is text-only. */
export const REGIONS: readonly RegionDef[] = [
  { id: 'shoulders', label: 'Shoulders', sourceKeys: ['shoulders'] },
  { id: 'chest', label: 'Chest', sourceKeys: ['chest'] },
  { id: 'biceps', label: 'Biceps', sourceKeys: ['biceps'] },
  { id: 'triceps', label: 'Triceps', sourceKeys: ['triceps'] },
  { id: 'forearms', label: 'Forearms', sourceKeys: ['forearms'] },
  { id: 'core', label: 'Core', sourceKeys: ['core', 'obliques'] },
  { id: 'hips', label: 'Hips', sourceKeys: ['hips'] },
  { id: 'glutes', label: 'Glutes', sourceKeys: ['glutes'] },
  { id: 'quads', label: 'Quads', sourceKeys: ['quads'] },
  { id: 'hamstrings', label: 'Hamstrings', sourceKeys: ['hamstrings'] },
  { id: 'calves', label: 'Calves', sourceKeys: ['calves'] },
  { id: 'upper_back', label: 'Upper Back', sourceKeys: ['lats', 'mid_back', 'traps'] },
  { id: 'lower_back', label: 'Lower Back', sourceKeys: ['low_back'] },
];

/**
 * Decides a region's state. This is the seam for swapping in a different method
 * (e.g. history-based) later: the drawing code only consumes the resulting states
 * and the legend text, never the thresholds themselves.
 */
export interface StateClassifier {
  classify(percent: number, regionId: RegionId): MuscleState;
  legend: Record<MuscleState, string>;
}

export interface MuscleThresholds {
  /** Percent at or above which a region counts as worked. */
  worked: number;
  /** Percent below which a region needs attention (absent keys are 0%). */
  attention: number;
}

export const DEFAULT_THRESHOLDS: MuscleThresholds = { worked: 10, attention: 5 };

/** Flat-percentage classifier. Percentages are whole numbers (regions are rounded before classifying). */
export function thresholdClassifier(thresholds: MuscleThresholds = DEFAULT_THRESHOLDS): StateClassifier {
  return {
    classify: (percent) => {
      if (percent >= thresholds.worked) return 'worked';
      if (percent >= thresholds.attention) return 'neutral';
      return 'attention';
    },
    legend: {
      worked: `Worked (${thresholds.worked}%+)`,
      neutral: `Neutral (${thresholds.attention}\u2013${thresholds.worked - 1}%)`,
      attention: `Needs attention (<${thresholds.attention}%)`,
    },
  };
}

export interface RegionResult {
  id: RegionId;
  label: string;
  /** Whole-number percent actually displayed; the state is computed from this same value. */
  percent: number;
  state: MuscleState;
}

function usable(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Sums each region's source keys (missing keys are 0), rounds to the displayed whole
 * percent, then classifies that rounded value. Rounding drift across regions (99-101%)
 * is intentionally not normalized.
 */
export function computeRegionResults(
  percentages: Readonly<Record<string, number>>,
  classifier: StateClassifier = thresholdClassifier()
): RegionResult[] {
  return REGIONS.map((region) => {
    const total = region.sourceKeys.reduce((sum, key) => sum + usable(percentages[key]), 0);
    const percent = Math.round(total);
    return {
      id: region.id,
      label: region.label,
      percent,
      state: classifier.classify(percent, region.id),
    };
  });
}

/** True when every region rounds to 0%. This alone does not say whether any workouts happened. */
export function isEmptyChartData(results: readonly RegionResult[]): boolean {
  return results.every((result) => result.percent === 0);
}

/**
 * - no_workouts: nothing was logged in the period.
 * - no_muscle_data: workouts exist but none map to a body region (e.g. meditation-only or
 *   unknown-discipline-only), so there is nothing to color.
 */
export type ChartEmptyReason = 'no_workouts' | 'no_muscle_data';

/**
 * The caller's workoutCount is the source of truth for "no workouts"; empty regions are never
 * used to infer it. Returns null when there is data to draw.
 */
export function getEmptyReason(workoutCount: number, results: readonly RegionResult[]): ChartEmptyReason | null {
  if (!(workoutCount > 0)) {
    return 'no_workouts';
  }
  return isEmptyChartData(results) ? 'no_muscle_data' : null;
}

/** Convert the legacy estimate to Peloton keys without changing its denominator. */
export function impactToPercentages(impact: MuscleImpactData): Record<string, number> {
  return impactToPelotonPercentages(impact);
}
