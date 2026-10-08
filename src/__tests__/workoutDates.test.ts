import { afterEach, describe, expect, it, vi } from 'vitest';

async function dates(zone?: string) {
  vi.resetModules();
  vi.stubEnv('APP_TIMEZONE', zone);
  vi.stubEnv('TZ', 'UTC'); // Match Fly; calendar conversion must use APP_TIMEZONE instead.
  return import('../utils/workoutDates.js');
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('shared workout date normalizer', () => {
  it('defaults to New York even on a UTC host, with a half-open local calendar day', async () => {
    const { normalizeWorkoutDateRange } = await dates();
    const range = normalizeWorkoutDateRange('2026-10-08', '2026-10-08');
    expect(range.startDate?.toISOString()).toBe('2026-10-08T04:00:00.000Z');
    expect(range.endDate?.toISOString()).toBe('2026-10-09T04:00:00.000Z');
    expect(range.endExclusive).toBe(true);
  });
  it.each([
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
    ['2026-02-28', '2026-02-28T05:00:00.000Z', '2026-03-01T05:00:00.000Z', 24],
    ['2028-02-29', '2028-02-29T05:00:00.000Z', '2028-03-01T05:00:00.000Z', 24],
    ['2026-12-31', '2026-12-31T05:00:00.000Z', '2027-01-01T05:00:00.000Z', 24],
  ])('uses calendar arithmetic for %s', async (day, start, end, hours) => {
    const { normalizeWorkoutDateRange } = await dates();
    const range = normalizeWorkoutDateRange(day, day);
    expect(range.startDate?.toISOString()).toBe(start);
    expect(range.endDate?.toISOString()).toBe(end);
    expect((range.endDate!.getTime() - range.startDate!.getTime()) / 3600000).toBe(hours);
  });
  it.each([
    ['UTC', '2026-10-08T00:00:00.000Z', '2026-10-09T00:00:00.000Z'],
    ['Pacific/Honolulu', '2026-10-08T10:00:00.000Z', '2026-10-09T10:00:00.000Z'],
    ['Asia/Kathmandu', '2026-10-07T18:15:00.000Z', '2026-10-08T18:15:00.000Z'],
  ])('honors APP_TIMEZONE=%s, including fractional-hour offsets', async (zone, start, end) => {
    const { normalizeWorkoutDateRange } = await dates(zone);
    const range = normalizeWorkoutDateRange('2026-10-08', '2026-10-08');
    expect(range.startDate?.toISOString()).toBe(start);
    expect(range.endDate?.toISOString()).toBe(end);
  });
  it.each([
    ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['America/Havana', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['America/Sao_Paulo', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z'],
  ])('handles DST at midnight in %s on %s', async (zone, day, start, end) => {
    const { normalizeWorkoutDateRange } = await dates(zone);
    const range = normalizeWorkoutDateRange(day, day);
    expect(range.startDate?.toISOString()).toBe(start);
    expect(range.endDate?.toISOString()).toBe(end);
  });
  it('excludes invalid instants when a direct Date caller supplies a bound', async () => {
    const { matchesWorkoutDateRange } = await dates();
    expect(matchesWorkoutDateRange(NaN, { startDate: new Date(0) })).toBe(false);
    expect(matchesWorkoutDateRange(0, { endDate: new Date(NaN) })).toBe(false);
  });
  it('handles a skipped civil day at a timezone date-line change', async () => {
    const { normalizeWorkoutDateRange } = await dates('Pacific/Apia');
    const range = normalizeWorkoutDateRange('2011-12-29', '2011-12-29');
    expect(range.startDate?.toISOString()).toBe('2011-12-29T10:00:00.000Z');
    expect(range.endDate?.toISOString()).toBe('2011-12-30T10:00:00.000Z');
    expect(() => normalizeWorkoutDateRange('2011-12-30')).toThrow('Calendar date does not exist in APP_TIMEZONE: Pacific/Apia');
    expect(() => normalizeWorkoutDateRange(undefined, '2011-12-30')).toThrow('Calendar date does not exist in APP_TIMEZONE: Pacific/Apia');
  });
  it('reports an invalid configured timezone clearly', async () => {
    const { normalizeWorkoutDateRange } = await dates('Not/A_Timezone');
    expect(() => normalizeWorkoutDateRange('2026-10-08')).toThrow('Invalid APP_TIMEZONE: Not/A_Timezone');
  });
  it('preserves timed bounds and milliseconds regardless of APP_TIMEZONE', async () => {
    const { normalizeWorkoutDateRange } = await dates('Pacific/Honolulu');
    const range = normalizeWorkoutDateRange('2026-10-08T10:00:00.500-04:00', '2026-10-08T14:01:00Z');
    expect(range.startDate?.toISOString()).toBe('2026-10-08T14:00:00.500Z');
    expect(range.endDate?.toISOString()).toBe('2026-10-08T14:01:00.000Z');
    expect(range.endExclusive).toBe(false);
  });
  it('distinguishes inclusive instant ends from exclusive calendar ends in the shared predicate', async () => {
    const { normalizeWorkoutDateRange, matchesWorkoutDateRange } = await dates();
    const calendar = normalizeWorkoutDateRange('2026-10-08', '2026-10-08');
    const start = calendar.startDate!.getTime() / 1000, end = calendar.endDate!.getTime() / 1000;
    expect(matchesWorkoutDateRange(start - 0.001, calendar)).toBe(false);
    expect(matchesWorkoutDateRange(start, calendar)).toBe(true);
    expect(matchesWorkoutDateRange(end - 0.001, calendar)).toBe(true);
    expect(matchesWorkoutDateRange(end, calendar)).toBe(false);
    const instant = normalizeWorkoutDateRange('2026-10-08T04:00:00.500Z', '2026-10-08T04:00:01.500Z');
    expect(matchesWorkoutDateRange(start, instant)).toBe(false);
    expect(matchesWorkoutDateRange(start + 0.5, instant)).toBe(true);
    expect(matchesWorkoutDateRange(start + 1.5, instant)).toBe(true);
    expect(matchesWorkoutDateRange(start + 1.501, instant)).toBe(false);
  });
  it('supports absent and single-ended ranges without manufacturing the other bound', async () => {
    const { normalizeWorkoutDateRange, matchesWorkoutDateRange } = await dates();
    expect(normalizeWorkoutDateRange()).toEqual({});
    expect(normalizeWorkoutDateRange('2026-10-08').endDate).toBeUndefined();
    expect(normalizeWorkoutDateRange(undefined, '2026-10-08').startDate).toBeUndefined();
    expect(matchesWorkoutDateRange(0, normalizeWorkoutDateRange())).toBe(true);
  });
  it.each(['2026-02-31', '2026-02-29', '2026-04-31', '2026-00-10', '2026-13-10', '2026-01-00', '2026-02-31T12:00:00Z'])('rejects impossible calendar date %s', async input => {
    const { normalizeWorkoutDateRange } = await dates();
    expect(() => normalizeWorkoutDateRange(input)).toThrow(`Invalid calendar date: ${input}`);
    expect(() => normalizeWorkoutDateRange(undefined, input)).toThrow(`Invalid calendar date: ${input}`);
  });
  it.each(['10/08/2026', '2026-10-08T25:00:00Z', '2026-10-08T12:60:00Z', '2026-10-08T12:00:00'])('rejects invalid or ambiguous timestamp %s', async input => {
    const { normalizeWorkoutDateRange } = await dates();
    expect(() => normalizeWorkoutDateRange(input)).toThrow('Date must be YYYY-MM-DD or an ISO timestamp with Z or a UTC offset');
  });
  it('rejects reversed calendar, instant, and mixed ranges but accepts equal instant bounds', async () => {
    const { normalizeWorkoutDateRange } = await dates();
    for (const [start, end] of [
      ['2026-10-09', '2026-10-08'],
      ['2026-10-08T14:00:00Z', '2026-10-08T13:00:00Z'],
      ['2026-10-09T04:00:00Z', '2026-10-08'],
    ]) expect(() => normalizeWorkoutDateRange(start, end)).toThrow('start_date must not be after end_date');
    expect(() => normalizeWorkoutDateRange('2026-10-08T14:00:00Z', '2026-10-08T14:00:00Z')).not.toThrow();
  });
});
