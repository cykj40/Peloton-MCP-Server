import { advanceEm } from './dejavuMetrics.js';
import type { ChartEmptyReason, MuscleState, RegionId, RegionResult, StateClassifier } from './muscleRegions.js';

/**
 * Builds the chart SVG. Pure string building: no rasterizing and no knowledge of thresholds
 * (it only sees region states and the classifier's legend text).
 *
 * All text is sized for DejaVu Sans, the font installed in the Docker image, which is wide.
 * Widths come from per-character metrics measured with resvg in the production image
 * (see dejavuMetrics.ts), not from an average-per-character guess.
 */

export const CHART_FONT_FAMILY = 'DejaVu Sans';

export const CANVAS_WIDTH = 880;
export const CANVAS_HEIGHT = 810;

export const NAME_FONT_SIZE = 13;
export const PERCENT_FONT_SIZE = 16;
/** Minimum horizontal padding each side of a region label (checked by tests). */
export const MIN_LABEL_PADDING = 14;
/** Minimum vertical padding above/below the two-line label block (checked by tests). */
export const MIN_LABEL_VERTICAL_PADDING = 10;

// Baselines of the two label lines, relative to the region's vertical center.
export const NAME_BASELINE_OFFSET = -4;
export const PERCENT_BASELINE_OFFSET = 16;
// Approximate cap height of DejaVu Sans as a fraction of font size.
export const CAP_HEIGHT_EM = 0.73;

/** Safety margin over the summed advance widths (covers rounding in the metrics table). */
const WIDTH_MARGIN = 1.03;

/** Estimated rendered width of `text` in DejaVu Sans; never less than the real width (checked by tests). */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const char of text) {
    em += advanceEm(char, bold);
  }
  return em * fontSize * WIDTH_MARGIN;
}

const COLORS = {
  worked: { fill: '#2E7D6B', stroke: '#1F5A4C', text: '#FFFFFF' },
  neutral: { fill: '#C9CED6', stroke: '#9AA3AD', text: '#1F2933' },
  attention: { fill: '#E8913A', stroke: '#8A4B0F', text: '#1F2933' },
} as const satisfies Record<MuscleState, { fill: string; stroke: string; text: string }>;

const OUTLINE = { fill: '#EEF0F3', stroke: '#B4BBC4' };
const MUTED_TEXT = '#5B6670';
const TITLE_TEXT = '#1F2933';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
}

export type ChartView = 'front' | 'back';

export interface RegionShape {
  view: ChartView;
  id: RegionId;
  rect: Rect;
}

// Local body coordinates: each view is 400 wide; the body starts at y = 0.
const SHOULDER_BAND: Rect = { x: 4, y: 64, w: 392, h: 64, rx: 28 };
const ARM_LEFT: Rect = { x: 4, y: 134, w: 84, h: 128, rx: 24 };
const ARM_RIGHT: Rect = { x: 312, y: 134, w: 84, h: 128, rx: 24 };
const UPPER_TORSO: Rect = { x: 92, y: 134, w: 216, h: 78, rx: 20 };
const LOWER_TORSO: Rect = { x: 92, y: 218, w: 216, h: 76, rx: 20 };
const HIPS: Rect = { x: 92, y: 300, w: 216, h: 66, rx: 22 };
const THIGH_LEFT: Rect = { x: 92, y: 372, w: 106, h: 124, rx: 24 };
const THIGH_RIGHT: Rect = { x: 202, y: 372, w: 106, h: 124, rx: 24 };
const SHIN_LEFT: Rect = { x: 96, y: 502, w: 98, h: 88, rx: 24 };
const SHIN_RIGHT: Rect = { x: 206, y: 502, w: 98, h: 88, rx: 24 };

// Unlabeled body parts drawn as plain outline, shared by both views.
const FOREARM_LEFT: Rect = { x: 12, y: 268, w: 68, h: 70, rx: 22 };
const FOREARM_RIGHT: Rect = { x: 320, y: 268, w: 68, h: 70, rx: 22 };

const REGION_SHAPES: readonly RegionShape[] = [
  { view: 'front', id: 'shoulders', rect: SHOULDER_BAND },
  { view: 'front', id: 'biceps', rect: ARM_LEFT },
  { view: 'front', id: 'biceps', rect: ARM_RIGHT },
  { view: 'front', id: 'chest', rect: UPPER_TORSO },
  { view: 'front', id: 'core', rect: LOWER_TORSO },
  { view: 'front', id: 'quads', rect: THIGH_LEFT },
  { view: 'front', id: 'quads', rect: THIGH_RIGHT },
  { view: 'back', id: 'shoulders', rect: SHOULDER_BAND },
  { view: 'back', id: 'triceps', rect: ARM_LEFT },
  { view: 'back', id: 'triceps', rect: ARM_RIGHT },
  { view: 'back', id: 'upper_back', rect: UPPER_TORSO },
  { view: 'back', id: 'lower_back', rect: LOWER_TORSO },
  { view: 'back', id: 'glutes', rect: HIPS },
  { view: 'back', id: 'hamstrings', rect: THIGH_LEFT },
  { view: 'back', id: 'hamstrings', rect: THIGH_RIGHT },
  { view: 'back', id: 'calves', rect: SHIN_LEFT },
  { view: 'back', id: 'calves', rect: SHIN_RIGHT },
];

const OUTLINE_SHAPES: Record<ChartView, readonly Rect[]> = {
  front: [FOREARM_LEFT, FOREARM_RIGHT, HIPS, SHIN_LEFT, SHIN_RIGHT],
  back: [FOREARM_LEFT, FOREARM_RIGHT],
};

/** Labeled region geometry, exposed so tests can check labels fit with padding. */
export function getRegionShapes(): readonly RegionShape[] {
  return REGION_SHAPES;
}

const VIEW_ORIGIN_X: Record<ChartView, number> = { front: 24, back: 456 };
const BODY_ORIGIN_Y = 106;
const VIEW_WIDTH = 400;
const HEAD = { cx: 200, cy: 34, r: 26 };

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function text(
  x: number,
  y: number,
  content: string,
  size: number,
  fill: string,
  opts: { bold?: boolean; anchor?: 'middle' | 'start'; letterSpacing?: number } = {}
): string {
  const weight = opts.bold ? ' font-weight="bold"' : '';
  const spacing = opts.letterSpacing ? ` letter-spacing="${opts.letterSpacing}"` : '';
  return (
    `<text x="${x}" y="${y}" text-anchor="${opts.anchor ?? 'middle'}" ` +
    `font-family="${CHART_FONT_FAMILY}" font-size="${size}"${weight}${spacing} fill="${fill}">${escapeXml(content)}</text>`
  );
}

function rectEl(rect: Rect, attrs: string): string {
  return `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="${rect.rx}" ${attrs}/>`;
}

function stateAttrs(state: MuscleState): string {
  const c = COLORS[state];
  const dash = state === 'attention' ? ' stroke-dasharray="7 5"' : '';
  const width = state === 'attention' ? 2.5 : 1.5;
  return `fill="${c.fill}" stroke="${c.stroke}" stroke-width="${width}"${dash}`;
}

function drawRegion(shape: RegionShape, result: RegionResult, isEmpty: boolean): string {
  const { rect } = shape;
  // Nothing to show: whole body neutral, names only (a "0%" would read as measured data).
  const state: MuscleState = isEmpty ? 'neutral' : result.state;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const textFill = COLORS[state].text;

  const label = isEmpty
    ? text(cx, cy + 5, result.label, NAME_FONT_SIZE, textFill)
    : text(cx, cy + NAME_BASELINE_OFFSET, result.label, NAME_FONT_SIZE, textFill) +
      text(cx, cy + PERCENT_BASELINE_OFFSET, `${result.percent}%`, PERCENT_FONT_SIZE, textFill, { bold: true });

  return rectEl(rect, stateAttrs(state)) + label;
}

function drawView(view: ChartView, results: ReadonlyMap<RegionId, RegionResult>, isEmpty: boolean): string {
  const outline = OUTLINE_SHAPES[view]
    .map((rect) => rectEl(rect, `fill="${OUTLINE.fill}" stroke="${OUTLINE.stroke}" stroke-width="1.5"`))
    .join('');
  const head = `<circle cx="${HEAD.cx}" cy="${HEAD.cy}" r="${HEAD.r}" fill="${OUTLINE.fill}" stroke="${OUTLINE.stroke}" stroke-width="1.5"/>`;

  const regions = REGION_SHAPES.filter((shape) => shape.view === view)
    .map((shape) => {
      const result = results.get(shape.id);
      return result ? drawRegion(shape, result, isEmpty) : '';
    })
    .join('');

  const title = view === 'front' ? 'FRONT' : 'BACK';
  const heading = text(VIEW_WIDTH / 2, -12, title, 13, MUTED_TEXT, { bold: true, letterSpacing: 2 });

  return (
    `<g transform="translate(${VIEW_ORIGIN_X[view]} ${BODY_ORIGIN_Y})">` + heading + head + outline + regions + '</g>'
  );
}

function drawLegend(classifier: StateClassifier, y: number): string {
  const states: MuscleState[] = ['worked', 'neutral', 'attention'];
  const swatch = 22;
  const swatchGap = 8;
  const itemGap = 36;

  const widths = states.map((state) => swatch + swatchGap + estimateTextWidth(classifier.legend[state], 13));
  const total = widths.reduce((sum, w) => sum + w, 0) + itemGap * (states.length - 1);
  let x = (CANVAS_WIDTH - total) / 2;

  let out = '';
  states.forEach((state, index) => {
    const swatchRect: Rect = { x, y: y - 16, w: swatch, h: swatch, rx: 6 };
    out += rectEl(swatchRect, stateAttrs(state));
    out += text(x + swatch + swatchGap, y + 1, classifier.legend[state], 13, TITLE_TEXT, { anchor: 'start' });
    x += (widths[index] ?? 0) + itemGap;
  });
  return out;
}

const EMPTY_NOTES: Record<ChartEmptyReason, string> = {
  no_workouts: 'No workouts in this period',
  no_muscle_data: 'No muscle data for these workouts',
};

export interface MuscleChartSvgInput {
  results: readonly RegionResult[];
  periodLabel: string;
  /** Non-null renders the whole body neutral with the matching note. */
  emptyReason: ChartEmptyReason | null;
  classifier: StateClassifier;
}

export function buildMuscleChartSvg(input: MuscleChartSvgInput): string {
  const results = new Map<RegionId, RegionResult>(input.results.map((result) => [result.id, result]));
  const center = CANVAS_WIDTH / 2;

  const isEmpty = input.emptyReason !== null;
  const note = input.emptyReason
    ? text(center, 66, EMPTY_NOTES[input.emptyReason], 16, MUTED_TEXT, { bold: true })
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">` +
    `<rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="#FFFFFF"/>` +
    text(center, 38, `Muscle activity \u00B7 ${input.periodLabel}`, 24, TITLE_TEXT, { bold: true }) +
    note +
    drawView('front', results, isEmpty) +
    drawView('back', results, isEmpty) +
    drawLegend(input.classifier, 742) +
    text(center, 784, 'Estimated from workout type and duration', 13, MUTED_TEXT) +
    '</svg>'
  );
}
