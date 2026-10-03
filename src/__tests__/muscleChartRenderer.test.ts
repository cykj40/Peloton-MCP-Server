import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it, vi } from 'vitest';
import { buildChartSvg, rasterizeSvg, renderMuscleChartPng } from '../charts/muscleChartRenderer.js';
import {
  CAP_HEIGHT_EM,
  CHART_FONT_FAMILY,
  MIN_LABEL_PADDING,
  MIN_LABEL_VERTICAL_PADDING,
  NAME_BASELINE_OFFSET,
  NAME_FONT_SIZE,
  PERCENT_BASELINE_OFFSET,
  PERCENT_FONT_SIZE,
  buildMuscleChartSvg,
  estimateTextWidth,
  getRegionShapes,
} from '../charts/muscleChartSvg.js';
import {
  REGIONS,
  computeRegionResults,
  getEmptyReason,
  impactToPercentages,
  thresholdClassifier,
} from '../charts/muscleRegions.js';
import { calculateMuscleImpact, formatMuscleName } from '../services/analytics.js';
import { handleAnalyticsTool } from '../tools/analytics.js';
import type { PelotonWorkout } from '../types/index.js';
import { makeMockWorkout } from './fixtures.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Percent text is a whole <text> element like ">14%<"; legend text has other characters around "%".
const PERCENT_LABEL = />\d+%<\/text>/;

function stripText(svg: string): string {
  return svg.replace(/<text[\s\S]*?<\/text>/g, '');
}

describe('chart font rendering', () => {
  // resvg silently drops <text> when no matching font is installed, so a missing font
  // shows up here as identical PNG sizes. This must stay loud in the Docker image.
  it('renders a label: PNG with a label differs in size from the same SVG without it', () => {
    const body = '<rect width="260" height="90" fill="#FFFFFF"/><ellipse cx="40" cy="45" rx="30" ry="20" fill="#E8913A"/>';
    const label = `<text x="85" y="55" font-family="${CHART_FONT_FAMILY}" font-size="20" fill="#111111">Hamstrings 22%</text>`;
    const open = '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="90">';

    const withLabel = rasterizeSvg(`${open}${body}${label}</svg>`);
    const withoutLabel = rasterizeSvg(`${open}${body}</svg>`);

    expect(withLabel.length).not.toBe(withoutLabel.length);
    expect(withLabel.length).toBeGreaterThan(withoutLabel.length);
  });

  it('renders the full chart text: stripping every <text> element changes the PNG size', () => {
    const results = computeRegionResults({ quadriceps: 40, hamstrings: 30, glutes: 30 });
    const svg = buildMuscleChartSvg({
      results,
      periodLabel: 'Last 7 days',
      emptyReason: null,
      classifier: thresholdClassifier(),
    });

    const withText = rasterizeSvg(svg);
    const withoutText = rasterizeSvg(stripText(svg));

    expect(withText.length).toBeGreaterThan(withoutText.length);
  });
});

describe('chart layout', () => {
  const names = new Map(REGIONS.map((region) => [region.id, region.label]));

  it('has a labeled shape for every region in the front/back views', () => {
    const shapeIds = new Set(getRegionShapes().map((shape) => shape.id));
    for (const region of REGIONS) {
      expect(shapeIds.has(region.id)).toBe(true);
    }
  });

  // Worst case per shape: the widest label line is either the region's own name (regular)
  // or "100%" in bold at the percent font size, whichever is wider. "100%" is the maximum
  // possible percent text, not a typical value.
  it('fits worst-case labels (bold "100%" and the shape\'s own region name) with generous padding', () => {
    const worstPercent = estimateTextWidth('100%', PERCENT_FONT_SIZE, true);
    for (const shape of getRegionShapes()) {
      const name = names.get(shape.id) ?? '';
      const widest = Math.max(estimateTextWidth(name, NAME_FONT_SIZE), worstPercent);
      expect(widest + 2 * MIN_LABEL_PADDING, `${shape.view}/${shape.id} width`).toBeLessThanOrEqual(shape.rect.w);
    }
  });

  it('leaves vertical padding above and below the two-line label block', () => {
    const topExtent = -NAME_BASELINE_OFFSET + NAME_FONT_SIZE * CAP_HEIGHT_EM; // above center
    const bottomExtent = PERCENT_BASELINE_OFFSET; // below center (digits have no descenders)
    for (const shape of getRegionShapes()) {
      const half = shape.rect.h / 2;
      expect(half - topExtent, `${shape.view}/${shape.id} top`).toBeGreaterThanOrEqual(MIN_LABEL_VERTICAL_PADDING);
      expect(half - bottomExtent, `${shape.view}/${shape.id} bottom`).toBeGreaterThanOrEqual(MIN_LABEL_VERTICAL_PADDING);
    }
  });

  // The estimates above are only trustworthy if they never undercount real DejaVu Sans widths.
  // Runs where DejaVu is installed (the Docker image, most Linux runners); skipped elsewhere.
  const dejaVuDirs = ['/usr/share/fonts/dejavu', '/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/TTF'];
  const hasDejaVu = dejaVuDirs.some((dir) => existsSync(join(dir, 'DejaVuSans.ttf')));

  function measure(text: string, size: number, bold: boolean): number {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="100"><text x="0" y="50" ` +
      `font-family="${CHART_FONT_FAMILY}" font-size="${size}"${bold ? ' font-weight="bold"' : ''}>${text}</text></svg>`;
    const box = new Resvg(svg, { font: { loadSystemFonts: true } }).getBBox();
    return box?.width ?? 0;
  }

  it.skipIf(!hasDejaVu)('estimates never undercount real DejaVu Sans text, and measured labels fit', () => {
    const measuredPercent = measure('100%', PERCENT_FONT_SIZE, true);
    expect(measuredPercent).toBeGreaterThan(0);
    expect(estimateTextWidth('100%', PERCENT_FONT_SIZE, true)).toBeGreaterThanOrEqual(measuredPercent);

    for (const shape of getRegionShapes()) {
      const name = names.get(shape.id) ?? '';
      const measuredName = measure(name, NAME_FONT_SIZE, false);
      expect(measuredName, `${name} measured`).toBeGreaterThan(0);
      expect(estimateTextWidth(name, NAME_FONT_SIZE), `${name} estimate`).toBeGreaterThanOrEqual(measuredName);

      const widest = Math.max(measuredName, measuredPercent);
      expect(widest + 2 * MIN_LABEL_PADDING, `${shape.view}/${shape.id} measured fit`).toBeLessThanOrEqual(shape.rect.w);
    }
  });
});

describe('empty states', () => {
  const quads = { quadriceps: 100 };

  it('workoutCount 0 renders "No workouts in this period", whatever the percentages say', () => {
    const svg = buildChartSvg({ percentages: {}, periodLabel: 'Last 7 days', workoutCount: 0 });
    expect(svg).toContain('No workouts in this period');
    expect(svg).not.toContain('No muscle data');
    expect(svg).not.toMatch(PERCENT_LABEL);

    // Contradictory input: the caller's count wins; regions are not used to infer it.
    const contradictory = buildChartSvg({ percentages: quads, periodLabel: 'Last 7 days', workoutCount: 0 });
    expect(contradictory).toContain('No workouts in this period');
    expect(contradictory).not.toMatch(PERCENT_LABEL);
  });

  it('workouts exist but no region has data: neutral body with "No muscle data for these workouts"', () => {
    const svg = buildChartSvg({ percentages: {}, periodLabel: 'Last 30 days', workoutCount: 3 });
    expect(svg).toContain('No muscle data for these workouts');
    expect(svg).not.toContain('No workouts in this period');
    expect(svg).not.toMatch(PERCENT_LABEL);
    // Neutral, not all-amber: the only amber fill is the legend swatch.
    expect(svg.match(/fill="#E8913A"/g) ?? []).toHaveLength(1);
  });

  it('shows neither note when there is data to draw', () => {
    const svg = buildChartSvg({ percentages: quads, periodLabel: 'Last 7 days', workoutCount: 2 });
    expect(svg).not.toContain('No workouts in this period');
    expect(svg).not.toContain('No muscle data');
    expect(svg).toMatch(PERCENT_LABEL);
  });

  it('getEmptyReason separates the two cases', () => {
    const zero = computeRegionResults({});
    const some = computeRegionResults(quads);
    expect(getEmptyReason(0, zero)).toBe('no_workouts');
    expect(getEmptyReason(0, some)).toBe('no_workouts');
    expect(getEmptyReason(4, zero)).toBe('no_muscle_data');
    expect(getEmptyReason(4, some)).toBeNull();
  });

  it('meditation-only and unknown-discipline-only workouts are "no muscle data", not "no workouts"', () => {
    const meditation = [makeMockWorkout({ id: 'm', fitness_discipline: 'meditation' })];
    const unknown = [makeMockWorkout({ id: 'u', fitness_discipline: 'circuit' })];

    for (const workouts of [meditation, unknown]) {
      const percentages = impactToPercentages(calculateMuscleImpact(workouts));
      const svg = buildChartSvg({ percentages, periodLabel: 'Last 7 days', workoutCount: workouts.length });
      expect(svg).toContain('No muscle data for these workouts');
      expect(svg).not.toContain('No workouts in this period');
    }
  });
});

describe('parity with peloton_muscle_activity', () => {
  const base: PelotonWorkout[] = [
    makeMockWorkout({ id: 'c1', fitness_discipline: 'cycling', duration: 1800 }),
    makeMockWorkout({ id: 'c2', fitness_discipline: 'cycling', duration: 2700 }),
    makeMockWorkout({ id: 's1', fitness_discipline: 'strength', name: '20 min Upper Body Strength', duration: 1200 }),
    makeMockWorkout({ id: 's2', fitness_discipline: 'strength', name: '10 min Core', duration: 600 }),
    makeMockWorkout({ id: 'y1', fitness_discipline: 'yoga', duration: 1200 }),
    makeMockWorkout({ id: 'r1', fitness_discipline: 'running', duration: 2400 }),
  ];
  const withFullBody: PelotonWorkout[] = [
    ...base,
    makeMockWorkout({ id: 'u1', fitness_discipline: 'circuit', duration: 1800 }), // unknown discipline -> full_body
  ];

  const cases: Array<[string, PelotonWorkout[]]> = [
    ['without a full_body key', base],
    ['with a full_body key', withFullBody],
  ];

  async function activityFromTool(workouts: PelotonWorkout[]): Promise<Record<string, number>> {
    const client = {
      getRecentWorkouts: vi.fn().mockResolvedValue(workouts),
    } as unknown as Parameters<typeof handleAnalyticsTool>[2];
    const response = await handleAnalyticsTool(
      'peloton_muscle_activity',
      { period: '7_days', response_format: 'json' },
      client
    );
    const first = response.content[0];
    const text = first && first.type === 'text' ? first.text : '{}';
    return (JSON.parse(text) as { muscle_activity: Record<string, number> }).muscle_activity;
  }

  it.each(cases)('chart percentages equal the tool output %s', async (_name, workouts) => {
    const impact = calculateMuscleImpact(workouts);
    expect(Object.keys(impact).includes('full_body')).toBe(workouts === withFullBody);

    const activity = await activityFromTool(workouts);
    const percentages = impactToPercentages(impact);

    // Same set of muscles (the tool shows display names; the chart input uses raw keys).
    expect(Object.keys(percentages).map(formatMuscleName).sort()).toEqual(Object.keys(activity).sort());
    expect('Full Body' in activity).toBe(false);

    // Same value for every muscle once rounded the way the tool rounds.
    for (const [key, value] of Object.entries(percentages)) {
      expect(Math.round(value), key).toBe(activity[formatMuscleName(key)]);
    }
  });

  it.each(cases)('region percents match the tool %s', async (_name, workouts) => {
    const activity = await activityFromTool(workouts);
    const results = computeRegionResults(impactToPercentages(calculateMuscleImpact(workouts)));

    for (const region of REGIONS) {
      const result = results.find((r) => r.id === region.id);
      const toolSum = region.sourceKeys.reduce((sum, key) => sum + (activity[formatMuscleName(key)] ?? 0), 0);
      if (region.sourceKeys.length === 1) {
        expect(result?.percent, region.id).toBe(toolSum);
      } else {
        // Merged regions round the combined value once; the tool rounds each key separately,
        // so they can differ by at most (keys - 1) points.
        expect(Math.abs((result?.percent ?? 0) - toolSum), region.id).toBeLessThan(region.sourceKeys.length);
      }
    }
  });
});

describe('renderMuscleChartPng', () => {
  const cases: Array<[string, Record<string, number>, number]> = [
    ['typical mixed data', { quadriceps: 14, hamstrings: 15, core: 14, chest: 4, upper_back: 2 }, 6],
    ['no workouts', {}, 0],
    ['workouts with no muscle data', {}, 3],
    ['100% in one region', { quadriceps: 100 }, 1],
    ['unknown and invalid keys', { full_body: 50, bogus: 10, calves: Number.NaN, glutes: -5 }, 2],
  ];

  it.each(cases)('returns a valid PNG for %s', (_name, percentages, workoutCount) => {
    const png = renderMuscleChartPng({ percentages, periodLabel: 'Last 7 days', workoutCount });
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(png.length).toBeGreaterThan(1000);
  });
});
