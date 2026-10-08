/** Thermal ramp, interpolated in sRGB. Independent of rendering and classification. */
export const HEAT_STOPS = [
  [0, '#1D1A38'], [3, '#2D1058'], [7, '#781C6C'], [10, '#B23359'],
  [12, '#D34942'], [15, '#F5821A'], [17, '#FCAA0C'], [20, '#FCFFA4'],
] as const;

export function heatColor(pct: number): string {
  const value = Number.isNaN(pct) ? 0 : Math.max(0, Math.min(20, pct));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [high, to] = HEAT_STOPS[i]!;
    const [low, from] = HEAT_STOPS[i - 1]!;
    if (value > high) continue;
    const t = (value - low) / (high - low);
    const channels = [1, 3, 5].map(offset => {
      const a = parseInt(from.slice(offset, offset + 2), 16);
      const b = parseInt(to.slice(offset, offset + 2), 16);
      return Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
    });
    return `#${channels.join('').toUpperCase()}`;
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1]![1];
}
