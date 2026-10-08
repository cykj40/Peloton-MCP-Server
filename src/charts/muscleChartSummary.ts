import { REGIONS } from './muscleRegions.js';
import type { PlannerSummary } from './muscleChartSvg.js';
import { PROJECTION_ASSUMPTION, regionPercentages, type MusclePlan } from '../services/muscleRecommendations.js';

const titleCase = (value: string): string => value.replace(/\b[a-z]/g, char => char.toUpperCase());

/** Presentation of the next session type and the plan's largest lifts in low regions. */
export function summarizeMusclePlan(plan: MusclePlan): PlannerSummary | null {
  const first = plan.suggestions[0];
  if (!first) return null;
  const candidate = first.candidate;
  const count = plan.suggestions.filter(suggestion => suggestion.candidate.key === candidate.key).length;
  const others = plan.suggestions.length - count;
  const before = regionPercentages(plan.before), after = regionPercentages(plan.after);
  const shifts = REGIONS.filter(region => before[region.id] < 5 && after[region.id] > before[region.id])
    .sort((a, b) => (after[b.id] - before[b.id]) - (after[a.id] - before[a.id])).slice(0, 3);
  const focus = candidate.focus === 'general' ? '' : `${titleCase(candidate.focus)} `;
  return {
    sessionLine: `${count} × ${candidate.durationMinutes} min ${focus}${titleCase(candidate.discipline)}`,
    shiftsLine: shifts.map(region => `${region.label} ${Math.round(before[region.id])} → ${Math.round(after[region.id])}%`).join(' · '),
    caveatLine: `${others ? `${others} other session${others === 1 ? '' : 's'} in the full plan. ` : ''}${PROJECTION_ASSUMPTION}`,
  };
}
