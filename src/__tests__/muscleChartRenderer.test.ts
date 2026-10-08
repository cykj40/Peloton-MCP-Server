import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it, vi } from 'vitest';
import { buildChartSvg, rasterizeSvg, renderMuscleChartPng } from '../charts/muscleChartRenderer.js';
import { CHART_FONT_FAMILY, buildMuscleChartSvg, estimateTextWidth } from '../charts/muscleChartSvg.js';
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

// Body percentage labels use 8.5 units; legend ticks also contain percentages.
const PERCENT_LABEL = /font-size="8\.5"[^>]*>\d+%<\/text>/;

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
    const results = computeRegionResults({ quads: 40, hamstrings: 30, glutes: 30 });
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

describe('chart layout and font metrics', () => {
  const dejaVuDirs = ['/usr/share/fonts/dejavu', '/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/TTF'];
  const hasDejaVu = dejaVuDirs.some(dir => existsSync(join(dir, 'DejaVuSans.ttf')));
  it.skipIf(!hasDejaVu)('estimates never undercount real DejaVu Sans labels and card text', () => {
    for (const value of [...REGIONS.map(region => region.label), '100%', '2 × 30 min Upper Body Strength', 'Chest 2 → 4% · Triceps 3 → 6%']) {
      for (const bold of [false, true]) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="100"><text x="0" y="50" font-family="${CHART_FONT_FAMILY}" font-size="18"${bold ? ' font-weight="bold"' : ''}>${value}</text></svg>`;
        const measured = new Resvg(svg, { font: { loadSystemFonts: true } }).getBBox()?.width ?? 0;
        expect(measured).toBeGreaterThan(0);
        expect(estimateTextWidth(value, 18, bold)).toBeGreaterThanOrEqual(measured);
      }
    }
  });
});

describe('empty states', () => {
  const quads = { quads: 100 };

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
    expect(svg).not.toContain('data-attention=');
    expect(svg).not.toContain('data-low=');
    expect(svg).toContain('fill="#1D1A38"');
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

  it.each(cases)("chart percentages preserve legacy tool shares after key translation %s", async (_name, workouts) => {
    const activity = await activityFromTool(workouts);
    const percentages = impactToPercentages(calculateMuscleImpact(workouts));
    const aliases: Record<string, string> = { Quadriceps: 'Quads', 'Lower Back': 'Low Back', Back: 'Mid Back', 'Upper Back': 'Mid Back' };
    const translated: Record<string, number> = {};
    for (const [key, value] of Object.entries(activity)) {
      const name = aliases[key] ?? key;
      translated[name] = (translated[name] ?? 0) + value;
    }
    expect(Object.keys(percentages).map(formatMuscleName).sort()).toEqual(Object.keys(translated).sort());
    for (const [key, value] of Object.entries(percentages)) {
      // The old tool rounds before combining back aliases; the chart rounds after combining.
      expect(Math.abs(Math.round(value) - (translated[formatMuscleName(key)] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  it.each(cases)("region values preserve legacy tool totals after Peloton key translation %s", async (_name, workouts) => {
    const activity = await activityFromTool(workouts);
    const aliases: Record<string, string[]> = {
      quads: ['Quadriceps'], low_back: ['Lower Back'], mid_back: ['Back', 'Upper Back'],
    };
    const results = computeRegionResults(impactToPercentages(calculateMuscleImpact(workouts)));
    for (const region of REGIONS) {
      const toolSum = region.sourceKeys.reduce((sum, key) => sum +
        (aliases[key] ?? [formatMuscleName(key)]).reduce((subtotal, name) => subtotal + (activity[name] ?? 0), 0), 0);
      const actual = results.find(result => result.id === region.id)!.percent;
      expect(Math.abs(actual - toolSum), region.id).toBeLessThanOrEqual(1);
    }
  });
});

describe('renderMuscleChartPng', () => {
  const cases: Array<[string, Record<string, number>, number]> = [
    ['typical mixed data', { quads: 14, hamstrings: 15, core: 14, chest: 4, mid_back: 2 }, 6],
    ['no workouts', {}, 0],
    ['workouts with no muscle data', {}, 3],
    ['100% in one region', { quads: 100 }, 1],
    ['unknown and invalid keys', { full_body: 50, bogus: 10, calves: Number.NaN, glutes: -5 }, 2],
  ];

  it.each(cases)('returns a valid PNG for %s', (_name, percentages, workoutCount) => {
    const png = renderMuscleChartPng({ percentages, periodLabel: 'Last 7 days', workoutCount });
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(png.length).toBeGreaterThan(1000);
  });
});
