import { describe, expect, it } from 'vitest';
import { REGIONS, computeRegionResults, impactToPercentages } from '../charts/muscleRegions.js';
import { formatMuscleChartText } from '../charts/muscleChartText.js';
import { PELOTON_MUSCLE_KEYS } from '../types/muscleData.js';
import type { MusclePercentages } from '../types/muscleData.js';

const realThirtyDays: MusclePercentages = {
  glutes: 15.0, core: 14.7, hamstrings: 11.4, quads: 11.1, shoulders: 10.4,
  hips: 7.3, calves: 5.9, obliques: 5.0, triceps: 4.8, low_back: 4.2,
  chest: 3.7, biceps: 2.2, lats: 1.3, mid_back: 1.1, traps: 1.0, forearms: 0.9,
};

describe('Peloton muscle regions', () => {
  it('maps all 16 anatomical keys exactly once into 13 regions, excluding other', () => {
    const keys = REGIONS.flatMap(region => [...region.sourceKeys]);
    expect(REGIONS).toHaveLength(13);
    expect(keys).toHaveLength(16);
    expect(new Set(keys).size).toBe(16);
    expect([...keys].sort()).toEqual(PELOTON_MUSCLE_KEYS.filter(key => key !== 'other').sort());
    expect(REGIONS.some(region => region.sourceKeys.includes('other'))).toBe(false);
  });

  it('adds shares, rounds region values, then classifies the real 30-day sample', () => {
    const sum = (id: string) => REGIONS.find(region => region.id === id)!.sourceKeys
      .reduce((total, key) => total + (realThirtyDays[key] ?? 0), 0);
    expect(sum('core')).toBeCloseTo(19.7);
    expect(sum('upper_back')).toBeCloseTo(3.4);
    expect(sum('triceps')).toBeCloseTo(4.8);
    expect(computeRegionResults(realThirtyDays).map(({ id, percent, state }) => ({ id, percent, state }))).toEqual([
      { id: 'shoulders', percent: 10, state: 'worked' },
      { id: 'chest', percent: 4, state: 'attention' },
      { id: 'biceps', percent: 2, state: 'attention' },
      { id: 'triceps', percent: 5, state: 'neutral' },
      { id: 'forearms', percent: 1, state: 'attention' },
      { id: 'core', percent: 20, state: 'worked' },
      { id: 'hips', percent: 7, state: 'neutral' },
      { id: 'glutes', percent: 15, state: 'worked' },
      { id: 'quads', percent: 11, state: 'worked' },
      { id: 'hamstrings', percent: 11, state: 'worked' },
      { id: 'calves', percent: 6, state: 'neutral' },
      { id: 'upper_back', percent: 3, state: 'attention' },
      { id: 'lower_back', percent: 4, state: 'attention' },
    ]);
  });

  it('reports Other separately in text without redistributing it to body regions', () => {
    const data = { percentages: { core: 60, other: 40 }, source: 'peloton_class_data' as const, workoutsTotal: 3, workoutsWithData: 2 };
    const result = computeRegionResults(data.percentages);
    expect(result.find(region => region.id === 'core')?.percent).toBe(60);
    expect(result).toHaveLength(13);
    const text = formatMuscleChartText(data);
    expect(text).toContain('Core: 60%');
    expect(text).toContain('Other: 40%');
    expect(text).toContain('class data: 2/3 workouts');
    expect(text).not.toContain('Core: 100%');
  });

  it('shows an all-other result without pretending a body region has data', () => {
    expect(computeRegionResults({ other: 100 }).every(region => region.percent === 0)).toBe(true);
    expect(formatMuscleChartText({ percentages: { other: 100 }, source: 'peloton_class_data', workoutsTotal: 1, workoutsWithData: 1 })).toContain('Other: 100%');
  });

  it('converts legacy estimate names to Peloton keys and preserves nonvisual denominator contributions', () => {
    const percentages = impactToPercentages({
      quadriceps: { score: 20, workouts: 1 }, lower_back: { score: 10, workouts: 1 },
      back: { score: 10, workouts: 1 }, upper_back: { score: 10, workouts: 1 },
      full_body: { score: 50, workouts: 1 },
    });
    expect(percentages).toEqual({ quads: 20, low_back: 10, mid_back: 20 });
    expect(computeRegionResults(percentages).find(region => region.id === 'upper_back')?.percent).toBe(20);
  });
});
