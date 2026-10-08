import { Resvg } from '@resvg/resvg-js';
import { compactPng } from './compactPng.js';
import { buildMuscleChartSvg, type ChartSourceInfo, type PlannerSummary } from './muscleChartSvg.js';
import {
  computeRegionResults,
  getEmptyReason,
  thresholdClassifier,
  type StateClassifier,
} from './muscleRegions.js';

/** Output is rendered at this multiple of the SVG's 1200px width so small labels stay crisp. */
const RENDER_ZOOM = 1.5;

export interface MuscleChartInput {
  /** Percent by raw snake_case key (see impactToPercentages). Missing keys count as 0%. */
  percentages: Readonly<Record<string, number>>;
  /** Shown in the title, e.g. "Last 7 days". */
  periodLabel: string;
  /** Workouts in the period. 0 renders "No workouts"; empty regions are never used to infer this. */
  workoutCount: number;
  /** Defaults to the flat 5% / 10% thresholds; swap to change how states are decided. */
  classifier?: StateClassifier;
  sourceInfo?: ChartSourceInfo;
  plannerSummary?: PlannerSummary | null;
}

/**
 * Rasterizes an SVG string to PNG. Text is drawn from fonts installed on the system
 * (DejaVu Sans in the Docker image); resvg silently drops text when no font matches,
 * which the renderer tests guard against.
 */
export function rasterizeSvg(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: RENDER_ZOOM },
    font: { loadSystemFonts: true },
  });
  return compactPng(Buffer.from(resvg.render().asPng()));
}

/** Data in, SVG out (no rasterizing); exposed so the data-to-picture path can be inspected. */
export function buildChartSvg(input: MuscleChartInput): string {
  const classifier = input.classifier ?? thresholdClassifier();
  const results = computeRegionResults(input.percentages, classifier);
  return buildMuscleChartSvg({
    results,
    periodLabel: input.periodLabel,
    emptyReason: getEmptyReason(input.workoutCount, results),
    classifier,
    ...(input.sourceInfo ? { sourceInfo: input.sourceInfo } : {}),
    ...(input.plannerSummary !== undefined ? { plannerSummary: input.plannerSummary } : {}),
  });
}

export function renderMuscleChartPng(input: MuscleChartInput): Buffer {
  return rasterizeSvg(buildChartSvg(input));
}
