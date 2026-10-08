import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { PIECES, LABEL_ANCHORS, BASE_PATH } from '../charts/bodyGeometry.js';
import { HEAT_STOPS, heatColor } from '../charts/heatColor.js';
import { buildChartSvg, renderMuscleChartPng } from '../charts/muscleChartRenderer.js';
import { FIGURE_ORIGINS, FIGURE_SCALE, estimateTextWidth, wrapText, type PlannerSummary } from '../charts/muscleChartSvg.js';
import { REGIONS, thresholdClassifier, type StateClassifier } from '../charts/muscleRegions.js';
import { summarizeMusclePlan } from '../charts/muscleChartSummary.js';
import { buildSessionCandidates, recommendMuscleBalance } from '../services/muscleRecommendations.js';
import { calculateMuscleImpact } from '../services/analytics.js';
import { impactToPercentages } from '../charts/muscleRegions.js';
import { makeMockWorkout } from './fixtures.js';

const base = { periodLabel: 'Last 7 days', workoutCount: 7 };
const real = { core: 21, glutes: 17, hips: 15, hamstrings: 12, quads: 10, shoulders: 9, calves: 7, triceps: 3, low_back: 3, chest: 2, biceps: 2, mid_back: 0, forearms: 0 };
function render(svg: string) { return new Resvg(svg, { font: { loadSystemFonts: true } }).render(); }
function pixel(result: ReturnType<typeof render>, x: number, y: number): number[] {
  const offset = (Math.round(y) * result.width + Math.round(x)) * 4;
  return [...result.pixels.subarray(offset, offset + 4)];
}

describe('C3 geometry', () => {
  it('covers every mapped region with geometry and at least one label anchor', () => {
    for (const region of REGIONS) {
      expect(PIECES.some(piece => piece.regionId === region.id), region.id).toBe(true);
      expect(LABEL_ANCHORS.some(anchor => anchor.regionId === region.id), region.id).toBe(true);
    }
    for (const piece of PIECES) expect(REGIONS.some(region => region.id === piece.regionId)).toBe(true);
  });
  it('has unique path ids and one anchor per region per view, within matching view geometry', () => {
    expect(new Set(PIECES.map(piece => piece.id)).size).toBe(PIECES.length);
    expect(new Set(LABEL_ANCHORS.map(anchor => `${anchor.view}/${anchor.regionId}`)).size).toBe(LABEL_ANCHORS.length);
    for (const anchor of LABEL_ANCHORS) {
      expect(PIECES.some(piece => piece.view === anchor.view && piece.regionId === anchor.regionId)).toBe(true);
      expect(anchor.x).toBeGreaterThanOrEqual(100);
      expect(anchor.x).toBeLessThan(200);
      expect(anchor.y).toBeLessThan(440);
    }
  });
  it('renders every original path, including the repaired abs and inner quad, within the body viewBox', () => {
    for (const d of [BASE_PATH, ...PIECES.map(piece => piece.d)]) {
      const box = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="440"><path d="${d}"/></svg>`, { font: { loadSystemFonts: false } }).getBBox();
      expect(box, d).toBeTruthy();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
      expect(box!.x).toBeGreaterThanOrEqual(100);
      expect(box!.x + box!.width).toBeLessThanOrEqual(200);
      expect(box!.y + box!.height).toBeLessThanOrEqual(440);
    }
  });
});

describe('heatColor', () => {
  it.each(HEAT_STOPS)('returns exact colour at %s%%', (pct, color) => expect(heatColor(pct)).toBe(color));
  it('clamps endpoints and invalid values', () => {
    expect(heatColor(35)).toBe('#FCFFA4');
    expect(heatColor(-5)).toBe('#1D1A38');
    expect(heatColor(NaN)).toBe('#1D1A38');
  });
  it('interpolates 11% between the 10 and 12 percent stops in sRGB', () => {
    expect(heatColor(11)).toBe('#C33E4E');
    for (const offset of [1, 3, 5]) {
      const channel = parseInt(heatColor(11).slice(offset, offset + 2), 16);
      const bounds = ['#B23359', '#D34942'].map(color => parseInt(color.slice(offset, offset + 2), 16)).sort((a, b) => a - b);
      expect(channel).toBeGreaterThanOrEqual(bounds[0]!);
      expect(channel).toBeLessThanOrEqual(bounds[1]!);
    }
  });
  it('never decreases in perceived lightness at half-percent intervals', () => {
    function lightness(color: string): number {
      const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      // CIE L* is monotonic in this linear-light luminance Y.
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
    }
    for (let pct = 0.5; pct <= 20; pct += 0.5) expect(lightness(heatColor(pct)), `${pct}%`).toBeGreaterThanOrEqual(lightness(heatColor(pct - 0.5)));
  });
});

describe('classifier wiring', () => {
  it('outlines and LOW pills match only regions flagged by the supplied classifier', () => {
    const classifier: StateClassifier = { ...thresholdClassifier(), classify: (_, id) => id === 'core' ? 'attention' : 'neutral' };
    const svg = buildChartSvg({ ...base, percentages: real, classifier });
    const outlines = [...svg.matchAll(/data-attention="([^"]+)"/g)].map(match => match[1]);
    const pills = [...svg.matchAll(/data-low="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(outlines)).toEqual(new Set(['core']));
    expect(outlines).toHaveLength(PIECES.filter(piece => piece.regionId === 'core').length * 2);
    expect(pills).toEqual(['core']);
    expect(svg).toContain(`data-region="core" fill="${heatColor(21)}"`);
  });
  it('has no attention outlines or pills when a stub classifier flags nothing', () => {
    const classifier: StateClassifier = { ...thresholdClassifier(), classify: () => 'neutral' };
    const svg = buildChartSvg({ ...base, percentages: real, classifier });
    expect(svg).not.toContain('data-attention=');
    expect(svg).not.toContain('data-low=');
    // The legend retains its dashed swatch; there are no dashed body paths.
    expect(svg.match(/stroke-dasharray=/g)).toHaveLength(1);
  });
  it('suppresses heat, labels and attention even for contradictory empty input', () => {
    const svg = buildChartSvg({ ...base, workoutCount: 0, percentages: real });
    expect(svg).toContain('No workouts in this period');
    expect(svg).not.toContain('data-attention=');
    expect(svg).not.toContain('data-low=');
    expect(svg).not.toContain('>21%</text>');
    expect(svg).toContain('data-glow="front" opacity="0.85" filter="url(#glow-front)"></g>');
    expect(svg).toContain('data-region="core" fill="#1D1A38"');
  });
});

describe('source footer', () => {
  it('regression: class data is never labelled as estimated', () => {
    const svg = buildChartSvg({ ...base, percentages: real, sourceInfo: { source: 'peloton_class_data', workoutsTotal: 8, workoutsWithData: 6 } });
    expect(svg).toContain('From Peloton class muscle data.');
    expect(svg).not.toContain('Estimated from workout type and duration');
    expect(svg).toContain('Last 7 days · 6 of 8 workouts with muscle data');
  });
  it('labels estimated data correctly', () => {
    const svg = buildChartSvg({ ...base, percentages: real, sourceInfo: { source: 'estimate', workoutsTotal: 7, workoutsWithData: 0 } });
    expect(svg).toContain('Estimated from workout type and duration.');
    expect(svg).not.toContain('From Peloton class muscle data.');
  });
  it('labels mixed data with actual class and estimate counts, wrapping within the footer', () => {
    const svg = buildChartSvg({ ...base, percentages: real, sourceInfo: { source: 'mixed', workoutsTotal: 7, workoutsWithData: 4, workoutsEstimated: 2 } });
    const footer = [...svg.matchAll(/<text x="40" y="(?:839|853)"[^>]*>(.*?)<\/text>/g)].map(match => match[1]!);
    expect(footer.join(' ')).toBe('From Peloton class muscle data (4 workouts). Estimated from workout type and duration (2 workouts).');
    for (const value of footer) expect(estimateTextWidth(value, 12)).toBeLessThanOrEqual(580);
  });
});

describe('suggested next', () => {
  const summary: PlannerSummary = { sessionLine: '2 × 30 min Upper Body Strength', shiftsLine: 'Chest 2 → 4% · Triceps 3 → 6% · Upper Back 0 → 3%', caveatLine: 'Based on your past classes.' };
  it('renders supplied planner lines and caveat', () => {
    const svg = buildChartSvg({ ...base, percentages: real, plannerSummary: summary });
    for (const value of Object.values(summary)) expect(svg).toContain(value);
    expect(svg).not.toContain('Balanced week, no change suggested');
  });
  it('renders the balanced fallback for an absent plan', () => {
    expect(buildChartSvg({ ...base, percentages: real, plannerSummary: null })).toContain('Balanced week, no change suggested');
  });
  it('wraps long lines and long individual words within the card using DejaVu widths', () => {
    const long = { ...summary, sessionLine: '2 × 30 min Upper Body Strength with an extended session description from your past classes', shiftsLine: 'Chest 2 → 4% · Triceps 3 → 6% · Upper Back 0 → 3% · Forearms 0 → 2%' };
    const svg = buildChartSvg({ ...base, percentages: real, plannerSummary: long });
    for (const [value, size, bold] of [[long.sessionLine, 18, true], [long.shiftsLine, 14, false], ['W'.repeat(100), 18, true]] as const) {
      const lines = wrapText(value, 464, size, bold);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(estimateTextWidth(line, size, bold)).toBeLessThanOrEqual(464);
        if (value !== 'W'.repeat(100)) expect(svg).toContain(`>${line}</text>`);
      }
    }
    const labels = [...svg.matchAll(/<text x="672" y="(\d+)"[^>]*>(.*?)<\/text>/g)].filter(match => Number(match[1]) >= 535);
    expect(Math.max(...labels.map(match => Number(match[1])))).toBeLessThan(728);
  });
  it('summarizes the existing planner without changing its result, aggregating repeated sessions', () => {
    const candidates = buildSessionCandidates([{ rideId: 'arms', title: '30 min Upper Body Strength', discipline: 'strength', durationSeconds: 1800, scores: { biceps: 10 } }]);
    const scores = Object.fromEntries(REGIONS.filter(region => region.id !== 'biceps').map(region => [region.sourceKeys[0], 10]));
    const plan = recommendMuscleBalance(scores, candidates, 7);
    const snapshot = JSON.stringify(plan);
    const summary = summarizeMusclePlan(plan)!;
    expect(summary.sessionLine).toBe('1 × 30 min Upper Body Strength');
    expect(summary.shiftsLine).toBe('Biceps 0 → 8%');
    expect(summary.caveatLine).toContain('Projections assume');
    expect(JSON.stringify(plan)).toBe(snapshot);
    const repeated = { ...plan, suggestions: [...plan.suggestions, ...plan.suggestions] };
    expect(summarizeMusclePlan(repeated)?.sessionLine).toBe('2 × 30 min Upper Body Strength');
    expect(summarizeMusclePlan({ ...plan, suggestions: [] })).toBeNull();
  });
});

describe('C3 rendering on resvg 2.6.2', () => {
  const cycling = impactToPercentages(calculateMuscleImpact([makeMockWorkout({ fitness_discipline: 'cycling', duration: 1800 })]));
  it.each([
    ['real week', real, 7], ['empty period', {}, 0], ['cycling only', cycling, 1], ['100% core', { core: 100 }, 1],
  ] as const)('renders %s at 1800 × 1290 under 400 KB', (_, percentages, workoutCount) => {
    const png = renderMuscleChartPng({ ...base, percentages, workoutCount });
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(1800);
    expect(png.readUInt32BE(20)).toBe(1290);
    expect(png.length).toBeLessThan(400_000);
  });
  it('use href produces exactly the same figure pixels as inline paths, including mirrors', () => {
    const svg = buildChartSvg({ ...base, percentages: real });
    const paths = new Map([['body-base', BASE_PATH], ...PIECES.map(piece => [piece.id, piece.d])]);
    const inline = svg.replace(/<use href="#([^"]+)"([^>]*?)\/>/g, (_, id: string, attrs: string) => `<path d="${paths.get(id)}"${attrs}/>`);
    const rendered = render(svg);
    expect(rendered.pixels.equals(render(inline).pixels)).toBe(true);
    const p = pixel(rendered, FIGURE_ORIGINS.front.x + 123 * FIGURE_SCALE, FIGURE_ORIGINS.front.y + 101 * FIGURE_SCALE);
    expect(p.slice(0, 3)).toEqual([40, 19, 77]); // Chest at 2%, away from label and seams.
  });
  it('glow changes pixels just outside hot Core, while cold distant regions do not glow', () => {
    const svg = buildChartSvg({ ...base, percentages: { core: 21 }, classifier: { ...thresholdClassifier(), classify: () => 'neutral' } });
    const noGlow = svg.replace(/<g data-glow="[^"]+"[^>]*>[\s\S]*?<\/g>/g, '');
    const x = FIGURE_ORIGINS.front.x + 143 * FIGURE_SCALE, y = FIGURE_ORIGINS.front.y + 137 * FIGURE_SCALE;
    const glowing = render(svg), plain = render(noGlow);
    expect(pixel(glowing, x, y)).not.toEqual([11, 14, 20, 255]);
    expect(pixel(glowing, x, y)).not.toEqual(pixel(plain, x, y));
    const coldX = FIGURE_ORIGINS.front.x + 158 * FIGURE_SCALE, coldY = FIGURE_ORIGINS.front.y + 131 * FIGURE_SCALE;
    expect(pixel(glowing, coldX, coldY)).toEqual(pixel(plain, coldX, coldY));
    expect(svg).not.toContain('href="#bicep" fill="#FCFFA4"');
  });
  it('hides back trap attention edges beneath the foreground shoulder without changing paths', () => {
    const attention: StateClassifier = { ...thresholdClassifier(), classify: (_, id) => id === 'upper_back' ? 'attention' : 'neutral' };
    const neutral: StateClassifier = { ...thresholdClassifier(), classify: () => 'neutral' };
    const flagged = render(buildChartSvg({ ...base, percentages: real, classifier: attention }));
    const plain = render(buildChartSvg({ ...base, percentages: real, classifier: neutral }));
    const { x, y } = FIGURE_ORIGINS.back;
    // The outer trap boundary crosses the delt at (140, 71) in the original paths.
    for (const [px, py] of [[139, 70], [140, 71], [141, 71]]) {
      expect(pixel(flagged, x + px! * FIGURE_SCALE, y + py! * FIGURE_SCALE)).toEqual(pixel(plain, x + px! * FIGURE_SCALE, y + py! * FIGURE_SCALE));
    }
  });
  it('renders explicit DejaVu fonts on every text node and two separate halo passes', () => {
    const svg = buildChartSvg({ ...base, percentages: real });
    const texts = [...svg.matchAll(/<text\b([^>]*)>/g)];
    for (const match of texts) expect(match[1]).toContain('font-family="DejaVu Sans"');
    expect(svg).not.toContain('paint-order');
    expect(svg.match(/stroke-width="2.4"/g)).toHaveLength(LABEL_ANCHORS.length);
    expect(svg.match(/font-size="8.5"/g)).toHaveLength(LABEL_ANCHORS.length * 2);
  });
  it('sorts all 13 rows and scales the highest bar to the full track width', () => {
    const svg = buildChartSvg({ ...base, percentages: real });
    const rows = [...svg.matchAll(/data-row="([^"]+)"/g)].map(match => match[1]);
    expect(rows).toHaveLength(13);
    expect(rows.slice(0, 4)).toEqual(['core', 'glutes', 'hips', 'hamstrings']);
    expect(svg).toContain('width="232" height="6" rx="3" fill="#FCFFA4"');
  });
});
