import type { MuscleData } from '../types/muscleData.js';
import { computeRegionResults, thresholdClassifier } from './muscleRegions.js';
import type { StateClassifier } from './muscleRegions.js';

/** Text companion for the chart. Other retains its original share and is never a body region. */
export function formatMuscleChartText(
  data: MuscleData,
  classifier: StateClassifier = thresholdClassifier(),
): string {
  const regions = computeRegionResults(data.percentages, classifier);
  const other = data.percentages.other;
  const otherPercent = typeof other === 'number' && Number.isFinite(other) && other > 0
    ? Math.round(other) : 0;
  return [
    `Source: ${data.source}; class data: ${data.workoutsWithData}/${data.workoutsTotal} workouts`,
    ...regions.map(region => `${region.label}: ${region.percent}% — ${classifier.legend[region.state]}`),
    `Other: ${otherPercent}%`,
  ].join('\n');
}
