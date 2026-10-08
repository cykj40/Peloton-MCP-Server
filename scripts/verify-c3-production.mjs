/** Run in the final production image: node scripts/verify-c3-production.mjs /tmp/c3out */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { buildChartSvg, rasterizeSvg, renderMuscleChartPng } from '../dist/charts/muscleChartRenderer.js';
import { FIGURE_ORIGINS, FIGURE_SCALE, estimateTextWidth } from '../dist/charts/muscleChartSvg.js';
import { PIECES, BASE_PATH } from '../dist/charts/bodyGeometry.js';
import { thresholdClassifier, impactToPercentages, REGIONS } from '../dist/charts/muscleRegions.js';
import { summarizeMusclePlan } from '../dist/charts/muscleChartSummary.js';
import { buildSessionCandidates, recommendMuscleBalance } from '../dist/services/muscleRecommendations.js';
import { calculateMuscleImpact } from '../dist/services/analytics.js';

const out = process.argv[2] ?? '/tmp/c3out';
mkdirSync(out, { recursive: true });
const real = { core: 21, glutes: 17, hips: 15, hamstrings: 12, quads: 10, shoulders: 9, calves: 7, triceps: 3, low_back: 3, chest: 2, biceps: 2, mid_back: 0, forearms: 0 };
const base = { periodLabel: 'Last 7 days', workoutCount: 7, sourceInfo: { source: 'peloton_class_data', workoutsWithData: 7, workoutsTotal: 7 } };
const candidates = buildSessionCandidates([{ rideId: 'fixture-upper', title: '30 min Upper Body Strength', discipline: 'strength', durationSeconds: 1800, scores: { chest: 12, triceps: 12, biceps: 10, mid_back: 12, forearms: 10, shoulders: 4 } }]);
const summary = summarizeMusclePlan(recommendMuscleBalance(real, candidates, 7));
const cycling = impactToPercentages(calculateMuscleImpact([{ id: 'fixture-ride', name: '30 min Ride', fitness_discipline: 'cycling', duration: 1800, created_at: 0, status: 'COMPLETE' }]));
const fixtures = [
  ['real-week', { ...base, percentages: real, plannerSummary: summary }],
  ['empty-period', { ...base, workoutCount: 0, percentages: {}, sourceInfo: { source: 'peloton_class_data', workoutsWithData: 0, workoutsTotal: 0 } }],
  ['cycling-only', { ...base, workoutCount: 1, percentages: cycling, sourceInfo: { source: 'estimate', workoutsWithData: 0, workoutsTotal: 1 } }],
  ['one-region-100', { ...base, workoutCount: 1, percentages: { core: 100 }, sourceInfo: { source: 'peloton_class_data', workoutsWithData: 1, workoutsTotal: 1 } }],
];
const render = svg => new Resvg(svg, { font: { loadSystemFonts: true } }).render();
const pixel = (image, x, y) => {
  const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [...image.pixels.subarray(offset, offset + 4)];
};
for (const [name, input] of fixtures) {
  test(`compiled dist: ${name} is 1800 × 1290 and under 400 KB`, () => {
    const svg = buildChartSvg(input), png = renderMuscleChartPng(input);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 1800); assert.equal(png.readUInt32BE(20), 1290);
    assert.ok(png.length < 400_000, `${name}: ${png.length} bytes`);
    if (name === 'empty-period') {
      assert.ok(svg.includes('No workouts in this period'));
      assert.ok(!svg.includes('data-attention=')); assert.ok(!svg.includes('data-low='));
    }
    writeFileSync(join(out, `${name}.png`), png);
    writeFileSync(join(out, `${name}.svg`), svg);
    console.log(`${join(out, `${name}.png`)}: ${png.length} bytes`);
  });
}
test('production DejaVu: individual label and full chart text survive rasterization', () => {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="90"><rect width="260" height="90" fill="#FFFFFF"/><ellipse cx="40" cy="45" rx="30" ry="20" fill="#E8913A"/>';
  const label = '<text x="85" y="55" font-family="DejaVu Sans" font-size="20" fill="#111111">Hamstrings 22%</text>';
  assert.ok(rasterizeSvg(`${open}${label}</svg>`).length > rasterizeSvg(`${open}</svg>`).length);
  const svg = buildChartSvg(fixtures[0][1]);
  assert.ok(rasterizeSvg(svg).length > rasterizeSvg(svg.replace(/<text[\s\S]*?<\/text>/g, '')).length);
});
test('production DejaVu widths are covered by the existing estimate', () => {
  for (const value of [...REGIONS.map(region => region.label), '100%', summary.sessionLine, summary.shiftsLine]) {
    for (const bold of [false, true]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="100"><text x="0" y="50" font-family="DejaVu Sans" font-size="18"${bold ? ' font-weight="bold"' : ''}>${value}</text></svg>`;
      const width = new Resvg(svg, { font: { loadSystemFonts: true } }).getBBox()?.width ?? 0;
      assert.ok(width > 0); assert.ok(estimateTextWidth(value, 18, bold) >= width, value);
    }
  }
});
test('production resvg use href has the same pixels as inline original paths', () => {
  const svg = buildChartSvg(fixtures[0][1]);
  const paths = new Map([['body-base', BASE_PATH], ...PIECES.map(piece => [piece.id, piece.d])]);
  const inline = svg.replace(/<use href="#([^"]+)"([^>]*?)\/>/g, (_, id, attrs) => `<path d="${paths.get(id)}"${attrs}/>`);
  const rendered = render(svg);
  assert.ok(rendered.pixels.equals(render(inline).pixels));
  assert.deepEqual(pixel(rendered, 58 + 123 * FIGURE_SCALE, 176 + 101 * FIGURE_SCALE).slice(0, 3), [40, 19, 77]);
});
test('production blur lights pixels outside hot Core, with no glow in cold distant Biceps', () => {
  const svg = buildChartSvg({ ...base, percentages: { core: 21 }, classifier: { ...thresholdClassifier(), classify: () => 'neutral' } });
  const plain = render(svg.replace(/<g data-glow="[^"]+"[^>]*>[\s\S]*?<\/g>/g, '')), glowing = render(svg);
  const { x: ox, y: oy } = FIGURE_ORIGINS.front;
  const x = ox + 143 * FIGURE_SCALE, y = oy + 137 * FIGURE_SCALE;
  assert.notDeepEqual(pixel(glowing, x, y), pixel(plain, x, y));
  assert.deepEqual(pixel(plain, x, y), [18, 23, 34, 255]);
  assert.notDeepEqual(pixel(glowing, x, y), [11, 14, 20, 255]);
  assert.deepEqual(pixel(glowing, ox + 158 * FIGURE_SCALE, oy + 131 * FIGURE_SCALE), pixel(plain, ox + 158 * FIGURE_SCALE, oy + 131 * FIGURE_SCALE));
});
