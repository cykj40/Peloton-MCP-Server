import { advanceEm } from './dejavuMetrics.js';
import { BASE_PATH, HEAD, LABEL_ANCHORS, NECK_PATH, PIECES, type BodyView } from './bodyGeometry.js';
import { HEAT_STOPS, heatColor } from './heatColor.js';
import type { ChartEmptyReason, RegionId, RegionResult, StateClassifier } from './muscleRegions.js';

export const CHART_FONT_FAMILY = 'DejaVu Sans';
export const CANVAS_WIDTH = 1200;
export const CANVAS_HEIGHT = 860;
export const FIGURE_SCALE = 1.31;
export const FIGURE_ORIGINS = { front: { x: 58, y: 176 }, back: { x: 338, y: 176 } } as const;

/** Conservative DejaVu advance estimate, including characters outside the metrics table. */
export function estimateTextWidth(value: string, size: number, bold = false): number {
  return [...value].reduce((sum, char) => sum + advanceEm(char, bold), 0) * size * 1.03;
}

/** Explicit wrapping for resvg, including an individual word wider than the card. */
export function wrapText(value: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of value.trim().split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (estimateTextWidth(next, size, bold) <= width) { current = next; continue; }
    if (current) { lines.push(current); current = ''; }
    for (const char of word) {
      if (current && estimateTextWidth(current + char, size, bold) > width) {
        lines.push(current); current = '';
      }
      current += char;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type ChartSourceInfo = {
  source: 'peloton_class_data' | 'estimate'; workoutsWithData: number; workoutsTotal: number;
} | {
  source: 'mixed'; workoutsWithData: number; workoutsEstimated: number; workoutsTotal: number;
};
export interface PlannerSummary { sessionLine: string; shiftsLine: string; caveatLine?: string }
export interface MuscleChartSvgInput {
  results: readonly RegionResult[];
  periodLabel: string;
  emptyReason: ChartEmptyReason | null;
  classifier: StateClassifier;
  plannerSummary?: PlannerSummary | null;
  sourceInfo?: ChartSourceInfo;
}

export function sourceCaption(info: ChartSourceInfo): string {
  if (info.source === 'peloton_class_data') return 'From Peloton class muscle data.';
  if (info.source === 'estimate') return 'Estimated from workout type and duration.';
  if (info.source === 'mixed') return `From Peloton class muscle data (${info.workoutsWithData} workouts). Estimated from workout type and duration (${info.workoutsEstimated} workouts).`;
  return '';
}

function text(x: number, y: number, value: string, size: number, fill: string,
  opts: { bold?: boolean; anchor?: 'middle' | 'start' | 'end'; spacing?: number; attrs?: string } = {}): string {
  return `<text x="${x}" y="${y}" text-anchor="${opts.anchor ?? 'start'}" font-family="${CHART_FONT_FAMILY}" font-size="${size}" fill="${fill}"${opts.bold ? ' font-weight="bold"' : ''}${opts.spacing ? ` letter-spacing="${opts.spacing}"` : ''}${opts.attrs ? ` ${opts.attrs}` : ''}>${escapeXml(value)}</text>`;
}
function card(x: number, y: number, width: number, height: number, fill = '#121722'): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="${fill}"/>`;
}
function pair(id: string, attrs: string): string {
  return `<use href="#${id}" ${attrs}/><use href="#${id}" transform="matrix(-1 0 0 1 200 0)" ${attrs}/>`;
}
function drawView(view: BodyView, results: ReadonlyMap<RegionId, RegionResult>, empty: boolean): string {
  const origin = FIGURE_ORIGINS[view];
  const pieces = PIECES.filter(piece => piece.view === view);
  const base = `<ellipse cx="${HEAD.cx}" cy="${HEAD.cy}" rx="${HEAD.rx}" ry="${HEAD.ry}" fill="#141823"/><path d="${NECK_PATH}" fill="#141823"/>` + pair('body-base', 'fill="#141823"');
  const glow = pieces.filter(piece => (results.get(piece.regionId)?.percent ?? 0) >= 12 && !empty)
    .map(piece => pair(piece.id, `fill="${heatColor(results.get(piece.regionId)!.percent)}"`)).join('');
  const fills = pieces.map(piece => pair(piece.id, `data-region="${piece.regionId}" fill="${heatColor(empty ? 0 : results.get(piece.regionId)?.percent ?? 0)}" stroke="#141823" stroke-width="1.3" stroke-linejoin="round"`)).join('');
  const outlines = empty ? '' : pieces.filter(piece => results.get(piece.regionId)?.state === 'attention')
    .map(piece => pair(piece.id, `data-attention="${piece.regionId}" mask="url(#visible-${piece.id})" fill="none" stroke="#5CC8FF" stroke-width="0.9" stroke-dasharray="2.2 1.6" stroke-linejoin="round"`)).join('');
  const labels = empty ? '' : LABEL_ANCHORS.filter(anchor => anchor.view === view).map(anchor => {
    const pct = results.get(anchor.regionId)?.percent ?? 0;
    return text(anchor.x, anchor.y, `${pct}%`, 8.5, '#0B0E14', { bold: true, anchor: 'middle', attrs: 'stroke="#0B0E14" stroke-width="2.4" stroke-linejoin="round"' }) +
      text(anchor.x, anchor.y, `${pct}%`, 8.5, '#FFFFFF', { bold: true, anchor: 'middle' });
  }).join('');
  return text(origin.x + 131, 153, view.toUpperCase(), 11, '#9AA6B8', { bold: true, anchor: 'middle', spacing: 1.5 }) +
    `<g data-view="${view}" transform="translate(${origin.x} ${origin.y}) scale(${FIGURE_SCALE})">${base}<g data-glow="${view}" opacity="0.85" filter="url(#glow-${view})">${glow}</g>${fills}${outlines}${labels}</g>`;
}
function breakdown(results: readonly RegionResult[], empty: boolean): string {
  const sorted = [...results].sort((a, b) => b.percent - a.percent);
  const max = Math.max(1, ...sorted.map(result => result.percent));
  return card(648, 118, 512, 346) + text(672, 149, 'ACTIVITY BREAKDOWN', 13, '#9AA6B8', { bold: true, spacing: 1.5 }) +
    sorted.map((result, i) => {
      const y = 179 + i * 22;
      const lowX = 672 + estimateTextWidth(result.label, 13) + 8;
      const pill = !empty && result.state === 'attention'
        ? `<rect data-low="${result.id}" x="${lowX}" y="${y - 12}" width="31" height="16" rx="4" fill="none" stroke="#5CC8FF" stroke-width="1" stroke-dasharray="2.2 1.6"/>` + text(lowX + 15.5, y, 'LOW', 10, '#5CC8FF', { bold: true, anchor: 'middle' }) : '';
      return `<g data-row="${result.id}">` + text(672, y, result.label, 13, '#E8EDF5') + pill +
        `<rect x="844" y="${y - 7}" width="232" height="6" rx="3" fill="#1E2738"/><rect x="844" y="${y - 7}" width="${empty ? 0 : 232 * result.percent / max}" height="6" rx="3" fill="${heatColor(empty ? 0 : result.percent)}"/>` +
        text(1136, y, empty ? '—' : `${result.percent}%`, 13, '#E8EDF5', { bold: true, anchor: 'end' }) + '</g>';
    }).join('');
}
function suggested(summary: PlannerSummary | null | undefined): string {
  const blocks = [
    { value: summary?.sessionLine ?? 'Balanced week, no change suggested', size: 18, bold: true, fill: '#0B0F17' },
    { value: summary?.shiftsLine ?? '', size: 14, bold: false, fill: '#0B0F17' },
    { value: summary?.caveatLine ?? '', size: 13, bold: false, fill: '#4A5565' },
  ];
  let y = 535;
  const content = blocks.filter(block => block.value).map(block => {
    const lines = wrapText(block.value, 464, block.size, block.bold);
    const out = lines.map(value => {
      const label = text(672, y, value, block.size, block.fill, { bold: block.bold });
      y += block.size + 6;
      return label;
    }).join('');
    y += 8;
    return out;
  }).join('');
  // Allow extra bottom padding when summary lines wrap.
  const height = Math.max(232, y - 480 + 8);
  return card(648, 480, 512, height, '#E8EDF5') + text(672, 509, 'SUGGESTED NEXT', 13, '#4A5565', { bold: true, spacing: 1.5 }) + content;
}
function legend(classifier: StateClassifier): string {
  return text(648, 749, 'Heat', 13, '#9AA6B8') +
    `<rect x="1039" y="737" width="23" height="13" rx="3" fill="none" stroke="#5CC8FF" stroke-dasharray="2.2 1.6"><title>${escapeXml(classifier.legend.attention)}</title></rect>` +
    text(1071, 749, 'Under 5%', 13, '#9AA6B8') +
    '<rect x="648" y="765" width="512" height="10" rx="5" fill="url(#heat-ramp)"/>' +
    [0, 5, 10, 15, 20].map(pct => text(648 + 512 * pct / 20, 798, `${pct}%${pct === 20 ? '+' : ''}`, 12, '#9AA6B8', { anchor: pct === 0 ? 'start' : pct === 20 ? 'end' : 'middle' })).join('');
}
const EMPTY_NOTES: Record<ChartEmptyReason, string> = {
  no_workouts: 'No workouts in this period', no_muscle_data: 'No muscle data for these workouts',
};

/** Pure SVG composition; classification and the recommendation plan are supplied by callers. */
export function buildMuscleChartSvg(input: MuscleChartSvgInput): string {
  const empty = input.emptyReason !== null;
  const results = new Map(input.results.map(result => [result.id, result]));
  const info = input.sourceInfo ?? { source: 'estimate', workoutsTotal: 0, workoutsWithData: 0 };
  const subtitle = input.emptyReason ? EMPTY_NOTES[input.emptyReason] : `${input.periodLabel} · ${info.workoutsWithData} of ${info.workoutsTotal} workouts with muscle data`;
  // Later pieces occlude earlier ones. Mask hidden attention edges so they cannot
  // reappear across a foreground muscle when all outlines are drawn last.
  const masks = empty ? '' : PIECES.flatMap((piece, index) => {
    if (results.get(piece.regionId)?.state !== 'attention') return [];
    const occluders = PIECES.slice(index + 1).filter(next => next.view === piece.view)
      .map(next => `<use href="#${next.id}" fill="#000000" stroke="#000000" stroke-width="1.3" stroke-linejoin="round"/>`).join('');
    return [`<mask id="visible-${piece.id}" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="440"><rect width="200" height="440" fill="#FFFFFF"/>${occluders}</mask>`];
  }).join('');
  const defs = `<defs>${masks}<path id="body-base" d="${BASE_PATH}"/>` + PIECES.map(piece => `<path id="${piece.id}" d="${piece.d}"/>`).join('') +
    ['front', 'back'].map(view => `<filter id="glow-${view}" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="4"/></filter>`).join('') +
    '<linearGradient id="heat-ramp" x1="0%" y1="0%" x2="100%" y2="0%" color-interpolation="sRGB">' + HEAT_STOPS.map(([pct, color]) => `<stop offset="${pct * 5}%" stop-color="${color}"/>`).join('') + '</linearGradient></defs>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="860" viewBox="0 0 1200 860">${defs}<rect width="1200" height="860" fill="#0B0E14"/>` +
    text(40, 62, /^(Last 7 days|Rolling 7 days)$/.test(input.periodLabel) ? 'This week on your body' : input.periodLabel, 28, '#E8EDF5', { bold: true }) +
    text(40, 91, subtitle, 14, '#9AA6B8') + text(1160, 56, 'Share of total muscle score', 13, '#9AA6B8', { anchor: 'end' }) +
    card(40, 118, 580, 702) + drawView('front', results, empty) + drawView('back', results, empty) +
    breakdown(input.results, empty) + suggested(empty ? null : input.plannerSummary) + legend(input.classifier) +
    wrapText(sourceCaption(info), 580, 12).map((value, i) => text(40, 839 + i * 14, value, 12, '#9AA6B8')).join('') + '</svg>';
}
