import { MuscleActivityChartSchema } from '../schemas/index.js';
import { PelotonClassMuscleDataSource } from '../services/muscleDataSource.js';
import type { PelotonClient } from '../services/pelotonClient.js';
import { RideMuscleCache, rideMuscleCache } from '../services/rideMuscleCache.js';
import { buildSessionCandidates, recommendMuscleBalance, regionPercentages, PROJECTION_ASSUMPTION } from '../services/muscleRecommendations.js';
import { renderMuscleChartPng } from '../charts/muscleChartRenderer.js';
import { formatMuscleChartText } from '../charts/muscleChartText.js';
import { REGIONS } from '../charts/muscleRegions.js';
import { formatMuscleName } from '../services/analytics.js';
import type { ToolResponse } from '../types/index.js';

export const muscleActivityChartTool = {
  name: 'peloton_muscle_activity_chart',
  description: 'Review your training and plan muscle balance with a chart and suggestions from your own past classes. Use for “what did I do this week/month”, “what should I work out today”, “how balanced was my training”, “which muscles am I neglecting”, and “plan me a balanced week”. Use days=7 for a week or 30 for a month; windows are rolling. Includes workout history, muscle coverage, all regions, the Peloton app comparison, and projected balance. Suggestions concern muscle balance only. Do not use when raw JSON is requested: use peloton_muscle_activity instead.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 90, default: 7, description: 'Rolling window length in days.' },
      weighting: { type: 'string', enum: ['raw', 'per_minute'], default: 'raw', description: 'Raw Peloton scores or muscle shares weighted by workout minutes.' },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

const line = (value: string): string => value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim();
const percent = (value: number): string => `${value.toFixed(1)}%`;
const minutes = (seconds: number): string => Number.isInteger(seconds / 60) ? String(seconds / 60) : (seconds / 60).toFixed(1);

export async function handleMuscleActivityChart(
  args: unknown,
  client: PelotonClient,
  options: { now?: () => number; cache?: RideMuscleCache } = {},
): Promise<ToolResponse> {
  const parsed = MuscleActivityChartSchema.safeParse(args);
  if (!parsed.success) return { isError: true, content: [{ type: 'text', text: 'Invalid chart options. Use days 1–90 and weighting raw or per_minute.' }] };
  try {
    const { days, weighting } = parsed.data;
    const source = new PelotonClassMuscleDataSource(client, options.cache ?? rideMuscleCache, options.now ?? Date.now);
    const context = await source.getMuscleDataContext(days, weighting);
    const { data, workouts } = context;
    const disciplines = new Map<string, number>();
    for (const workout of workouts) disciplines.set(workout.fitness_discipline, (disciplines.get(workout.fitness_discipline) ?? 0) + 1);
    const lines = [
      `Muscle activity — rolling last ${days} days (${new Date(context.start).toISOString()} to ${new Date(context.end).toISOString()}). Dates below are UTC.`,
      `Workouts by discipline: ${[...disciplines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${line(name)} ${count}`).join(', ') || 'none'}; total ${data.workoutsTotal}.`,
      'Workouts:',
    ];
    const ordered = [...workouts].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    const limit = ordered.length > 15 ? 14 : 15;
    lines.push(...ordered.slice(0, limit).map(workout =>
      `- ${new Date(workout.created_at * 1000).toISOString().slice(0, 10)} | ${line(workout.fitness_discipline)} | ${line(workout.name)} | ${minutes(workout.duration)} min`));
    if (ordered.length > 15) lines.push(`- ${ordered.length - 14} more workouts in this window.`);
    if (!ordered.length) lines.push('No workouts in this rolling window.');
    lines.push(
      `Data source: ${data.source}. ${data.workoutsWithData} of ${data.workoutsTotal} workouts have Peloton muscle data.`,
      weighting === 'raw'
        ? "Weighting: raw = Peloton's own score units, so long or intense classes count more."
        : "Weighting: per_minute = each class's share of muscles weighted by the minutes you spent.",
      ...(data.source === 'estimate' ? ['Class data was unavailable; the displayed estimate uses the legacy discipline/title model rather than measured class weighting.'] : []),
      'All 13 regions (rounded before applying 5%/10% states); Hips and Forearms are listed here while the current figure has no shapes for them:',
      ...formatMuscleChartText(data).split('\n').slice(1).map(region => `- ${region}`),
    );
    try {
      const app = await client.getBodyActivity(new Date(context.start), new Date(context.end));
      lines.push(`Peloton app shows: ${app.topSix.map(muscle => `${line(formatMuscleName(muscle.muscle_group))} ${muscle.percentage}%`).join(', ')}; Other ${app.other}%. This is the app's own near-flat aggregate, separate from the class-score chart.`);
    } catch {
      // Optional comparison: do not leak request errors or prevent the chart from being returned.
    }
    const candidates = buildSessionCandidates(context.history, weighting);
    const plan = recommendMuscleBalance(data.source === 'peloton_class_data' ? context.scores : {}, candidates, days);
    lines.push('Suggestions for muscle balance only:', 'Projections use unrounded shares and target at least 5% per region.');
    if (!plan.suggestions.length) {
      const reason = data.source === 'estimate' ? 'class data is unavailable for reliable projections'
        : !workouts.length ? 'there are no workouts in this window'
        : !candidates.length ? 'there is no usable class history from the last 90 days'
        : plan.shortfallBefore <= 1e-9 ? 'all regions are at least 5%'
        : 'no remaining candidate reduces total shortfall by at least 0.5 percentage points';
      lines.push(`No suggestions: ${reason}.`);
    }
    for (const [index, suggestion] of plan.suggestions.entries()) {
      const candidate = suggestion.candidate;
      lines.push(`${index + 1}. ${candidate.durationMinutes} min ${line(candidate.discipline)} — ${candidate.focus} (${candidate.sampleCount} distinct past classes).`);
      lines.push(`   Examples: ${candidate.exampleTitles.map(title => `“${line(title)}”`).join('; ')}.`);
      lines.push(`   Lifts: ${suggestion.lifts.map(lift => `${REGIONS.find(region => region.id === lift.region)!.label} ${percent(lift.before)} → ${percent(lift.after)} (+${lift.points.toFixed(1)} points)`).join('; ')}.`);
    }
    if (plan.suggestions.length) {
      const before = regionPercentages(plan.before), after = regionPercentages(plan.after);
      lines.push('Projected percentages after the plan (including any decreases):');
      for (const region of REGIONS) lines.push(`${region.label}: ${percent(before[region.id])} → ${percent(after[region.id])}`);
      lines.push(`Other: ${percent(plan.before.other ?? 0)} → ${percent(plan.after.other ?? 0)}`);
    }
    lines.push(PROJECTION_ASSUMPTION);
    lines.push(data.source === 'estimate'
      ? 'Caveat: muscle scores are estimated from discipline and title; they are not Peloton class scores.'
      : 'Caveat: scores come from Peloton class data; they describe the classes, not measured individual muscle effort. Workouts without scores are excluded.');
    const png = renderMuscleChartPng({ percentages: data.percentages, periodLabel: `Rolling ${days} days`, workoutCount: data.workoutsTotal });
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: lines.join('\n') }] };
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'Unable to build the muscle activity chart. Please try again.' }] };
  }
}
