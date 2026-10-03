import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { PELOTON_API_URL } from '../constants.js';
import { closeDatabase, getDatabase } from '../db/database.js';
import { getCachedRideMuscles, upsertCachedRideMuscles } from '../db/muscleCache.js';
import { runMigrations } from '../db/migrations.js';
import { PelotonClient } from '../services/pelotonClient.js';
import { PelotonClassMuscleDataSource } from '../services/muscleDataSource.js';
import { RideMuscleCache } from '../services/rideMuscleCache.js';
import { saveToken } from '../services/tokenStore.js';
import { PelotonMuscleScoresSchema } from '../schemas/muscleData.js';
import type { PelotonMuscleScore } from '../types/muscleData.js';
import { PelotonApiError, PelotonRateLimitError } from '../types/errors.js';
import { makeMockWorkout } from './fixtures.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 12);
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fixture.token';
const score = (muscle_group: string, value: number): PelotonMuscleScore => ({
  muscle_group, score: value, percentage: 50, bucket: 2, display_name: muscle_group,
});
const workout = (id: string, rideId: string | undefined, ageDays = 1) => makeMockWorkout({
  id, created_at: (NOW - ageDays * DAY) / 1000,
  ride: { ...(rideId ? { id: rideId } : {}), title: '30 Min HIIT Ride', duration: 1800 },
});

describe('Peloton muscle data source', () => {
  let client: PelotonClient;
  let clock: number;
  const now = () => clock;
  const source = () => new PelotonClassMuscleDataSource(client, new RideMuscleCache(now), now);
  function list(workouts: ReturnType<typeof workout>[]) {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'fixture', id: 'user1' });
    nock(PELOTON_API_URL).get('/api/user/user1/workouts').query({
      limit: 100, page: 0, joins: 'ride,ride.instructor', sort_by: '-created',
    }).reply(200, { data: workouts, total: workouts.length, show_next: false });
  }
  function details(rideId: string, scores: PelotonMuscleScore[] | null) {
    return nock(PELOTON_API_URL).get(`/api/ride/${rideId}/details`)
      .reply(200, { ride: { muscle_group_score: scores } });
  }

  beforeEach(async () => {
    clock = NOW;
    await setupTestDb();
    PelotonClient.clearCache();
    await saveToken({ access_token: TOKEN, token_type: 'Bearer', user_id: 'user1', expires_at: Date.now() + 90 * DAY });
    client = new PelotonClient(TOKEN);
    nock.cleanAll();
  });
  afterEach(async () => {
    const pending = nock.pendingMocks();
    nock.cleanAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await teardownTestDb();
    expect(pending).toEqual([]);
  });

  it('fetches once per unique ride, weights each workout by raw scores, and excludes empty data', async () => {
    list([workout('w1', 'a'), workout('w2', 'a'), workout('w3', 'b'), workout('w4', 'empty'), workout('w5', undefined)]);
    details('a', [score('glutes', 30), score('quads', 10)]);
    details('b', [score('glutes', 10), score('core', 10)]);
    details('empty', []);
    const result = await source().getMuscleData(30);
    expect(result).toEqual({ percentages: { glutes: 70, quads: 20, core: 10 }, source: 'peloton_class_data', workoutsTotal: 5, workoutsWithData: 3 });
    expect((await getCachedRideMuscles('a'))?.scores).toEqual([score('glutes', 30), score('quads', 10)]);
  });

  it.each(['raw', 'per_minute'] as const)('keeps partial successes without filling failures with estimates (%s)', async weighting => {
    list([workout('w1', 'good'), workout('w2', 'bad')]);
    details('good', [score('hips', 10)]);
    nock(PELOTON_API_URL).get('/api/ride/bad/details').reply(500, { message: 'unavailable' });
    expect(await source().getMuscleData(30, weighting)).toEqual({ percentages: { hips: 100 }, source: 'peloton_class_data', workoutsTotal: 2, workoutsWithData: 1 });
    expect(await getCachedRideMuscles('bad')).toBeNull();
  });

  it.each(['raw', 'per_minute'] as const)('falls back to the existing estimate, with Peloton key aliases, only when every lookup fails (%s)', async weighting => {
    list([workout('w1', 'bad')]);
    nock(PELOTON_API_URL).get('/api/ride/bad/details').reply(503);
    const result = await source().getMuscleData(30, weighting);
    expect(result.source).toBe('estimate');
    expect(result.workoutsWithData).toBe(0);
    expect(result.workoutsTotal).toBe(1);
    expect(result.percentages.quads).toBeCloseTo(900 / 41);
    expect(result.percentages.low_back).toBeCloseTo(400 / 41);
    expect(Object.values(result.percentages).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(result.percentages).not.toHaveProperty('quadriceps');
  });

  it.each(['raw', 'per_minute'] as const)('returns genuine empty data when empty responses succeed, even if another fetch fails (%s)', async weighting => {
    list([workout('w1', 'empty'), workout('w2', 'bad')]);
    details('empty', null);
    nock(PELOTON_API_URL).get('/api/ride/bad/details').reply(500);
    expect(await source().getMuscleData(30, weighting)).toEqual({ percentages: {}, source: 'peloton_class_data', workoutsTotal: 2, workoutsWithData: 0 });
  });

  it.each(['raw', 'per_minute'] as const)('returns an empty result without detail calls for an empty window (%s)', async weighting => {
    list([]);
    expect(await source().getMuscleData(1, weighting)).toEqual({ percentages: {}, source: 'peloton_class_data', workoutsTotal: 0, workoutsWithData: 0 });
  });

  it('uses the estimate for legacy workouts with no ride ids', async () => {
    list([workout('legacy', undefined)]);
    expect(await source().getMuscleData(90)).toMatchObject({ source: 'estimate', workoutsTotal: 1, workoutsWithData: 0 });
  });

  it.each([0, 91, 1.5, NaN, Infinity])('rejects invalid days %s before any request', async days => {
    await expect(source().getMuscleData(days)).rejects.toThrow(RangeError);
  });

  it('paginates, deduplicates boundary workouts, and respects both window boundaries', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'fixture', id: 'user1' });
    nock(PELOTON_API_URL).get('/api/user/user1/workouts').query(q => q['page'] === '0')
      .reply(200, { data: [workout('future', 'future', -1), workout('end', 'a', 0)], show_next: true });
    nock(PELOTON_API_URL).get('/api/user/user1/workouts').query(q => q['page'] === '1')
      .reply(200, { data: [workout('end', 'a', 0), workout('start', 'a', 30), workout('old', 'old', 31)], show_next: false });
    details('a', [score('core', 10)]);
    expect(await source().getMuscleData(30)).toEqual({ percentages: { core: 100 }, source: 'peloton_class_data', workoutsTotal: 2, workoutsWithData: 2 });
  });

  it('does not silently report incomplete coverage when workout pagination fails', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'fixture', id: 'user1' });
    nock(PELOTON_API_URL).get('/api/user/user1/workouts').query(true).reply(500);
    await expect(source().getMuscleData(30)).rejects.toThrow();
  });

  it('limits detail requests to four concurrently', async () => {
    const workouts = Array.from({ length: 9 }, (_, i) => workout(`w${i}`, `r${i}`));
    list(workouts);
    let active = 0;
    let maximum = 0;
    for (let i = 0; i < workouts.length; i++) {
      const scope = nock(PELOTON_API_URL).get(`/api/ride/r${i}/details`).delay(30)
        .reply(200, { ride: { muscle_group_score: [score('core', 10)] } });
      scope.on('request', () => { active++; maximum = Math.max(maximum, active); });
      scope.on('replied', () => { active--; });
    }
    expect((await source().getMuscleData(30)).workoutsWithData).toBe(9);
    expect(maximum).toBe(4);
  });

  it('reuses persisted metadata across new cache instances and reruns migrations safely', async () => {
    list([workout('w1', 'cached')]);
    details('cached', [score('hips', 10)]);
    await source().getMuscleData(30);
    await runMigrations();
    expect((await source().getMuscleData(30)).percentages).toEqual({ hips: 100 });
  });

  it.each([
    { scores: [score('core', 10)], ttl: 30 * DAY },
    { scores: [], ttl: DAY },
    { scores: [score('core', 0)], ttl: DAY },
  ])('revalidates at the exact TTL ($ttl), using both memory and persisted cache', async ({ scores, ttl }) => {
    const cache = new RideMuscleCache(now);
    details('cached', scores);
    await cache.get('cached', () => client.getRideMuscleScores('cached'));
    clock += ttl - 1;
    expect(await cache.get('cached', () => client.getRideMuscleScores('cached'))).toEqual(scores);
    expect(await new RideMuscleCache(now).get('cached', () => client.getRideMuscleScores('cached'))).toEqual(scores);
    clock += 1;
    details('cached', [score('hips', 20)]);
    expect(await cache.get('cached', () => client.getRideMuscleScores('cached'))).toEqual([score('hips', 20)]);
  });

  it('continues with memory caching when Turso is unavailable, including expiry', async () => {
    await closeDatabase();
    delete process.env.TURSO_DATABASE_URL;
    const cache = new RideMuscleCache(now);
    details('a', [score('core', 10)]);
    const fetch = () => client.getRideMuscleScores('a');
    expect(await cache.get('a', fetch)).toEqual([score('core', 10)]);
    expect(await cache.get('a', fetch)).toEqual([score('core', 10)]);
    clock += 30 * DAY;
    details('a', [score('hips', 10)]);
    expect(await cache.get('a', fetch)).toEqual([score('hips', 10)]);
  });

  it('coalesces concurrent calls for the same ride', async () => {
    const cache = new RideMuscleCache(now);
    details('a', [score('core', 10)]);
    const results = await Promise.all(Array.from({ length: 6 }, () => cache.get('a', () => client.getRideMuscleScores('a'))));
    expect(results).toHaveLength(6);
    expect(results.every(r => r[0]?.score === 10)).toBe(true);
  });

  it('does not serve expired data or cache a failed refresh', async () => {
    const cache = new RideMuscleCache(now);
    await upsertCachedRideMuscles('old', { scores: [score('core', 10)], fetchedAt: NOW - 30 * DAY });
    nock(PELOTON_API_URL).get('/api/ride/old/details').reply(500);
    await expect(cache.get('old', () => client.getRideMuscleScores('old'))).rejects.toThrow();
    details('old', [score('hips', 10)]);
    expect(await cache.get('old', () => client.getRideMuscleScores('old'))).toEqual([score('hips', 10)]);
  });

  it.each(['{broken', JSON.stringify([{ muscle_group: 'core', score: -1 }])])('refetches malformed cached JSON', async json => {
    await getDatabase().execute({ sql: 'INSERT INTO ride_muscle_cache VALUES (?, ?, ?)', args: ['bad-cache', json, NOW] });
    expect(await getCachedRideMuscles('bad-cache')).toBeNull();
    details('bad-cache', [score('core', 10)]);
    expect(await new RideMuscleCache(now).get('bad-cache', () => client.getRideMuscleScores('bad-cache'))).toEqual([score('core', 10)]);
  });

  it('rejects malformed API data rather than treating it as a successful empty response', async () => {
    list([workout('w1', 'malformed')]);
    nock(PELOTON_API_URL).get('/api/ride/malformed/details').reply(200, { ride: { muscle_group_score: [score('core', -10)] } });
    expect((await source().getMuscleData(30)).source).toBe('estimate');
    expect(await getCachedRideMuscles('malformed')).toBeNull();
  });

  it('validates score vectors without losing fractional scores', () => {
    expect(PelotonMuscleScoresSchema.parse([score('core', 3.25)])[0]?.score).toBe(3.25);
    for (const scores of [[score('core', Infinity)], [score('core', NaN)], [score('core', -1)], [{ score: 1 }], [{ muscle_group: 42, score: 1 }]]) {
      expect(PelotonMuscleScoresSchema.safeParse(scores).success).toBe(false);
    }
  });

  it('accepts minimal entries and unconstrained optional metadata', () => {
    const entries = [
      { muscle_group: 'core', score: 3.25 },
      { muscle_group: 'glutes', score: 2, bucket: -99, percentage: 200, display_name: null },
    ];
    expect(PelotonMuscleScoresSchema.parse(entries)).toEqual(entries);
  });

  it('merges duplicate entries by summing scores before calculating shares', async () => {
    list([workout('w1', 'duplicates')]);
    details('duplicates', [
      { muscle_group: 'core', score: 10 },
      { muscle_group: 'core', score: 20 },
      { muscle_group: 'glutes', score: 10 },
    ]);
    expect(await source().getMuscleData(30)).toEqual({
      percentages: { core: 75, glutes: 25 }, source: 'peloton_class_data',
      workoutsTotal: 1, workoutsWithData: 1,
    });
    expect((await getCachedRideMuscles('duplicates'))?.scores).toEqual([
      { muscle_group: 'core', score: 30 }, { muscle_group: 'glutes', score: 10 },
    ]);
  });

  it('keeps unknown scores in other and logs each unknown name only once across source instances', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    list([workout('w1', 'unknown'), workout('w2', 'unknown')]);
    details('unknown', [score('core', 60), score('future_muscle_a', 10), score('future_muscle_b', 30)]);
    const expected = {
      percentages: { core: 60, other: 40 }, source: 'peloton_class_data',
      workoutsTotal: 2, workoutsWithData: 2,
    };
    expect(await source().getMuscleData(30)).toEqual(expected);
    expect(await source().getMuscleData(30)).toEqual(expected);
    for (const key of ['future_muscle_a', 'future_muscle_b']) {
      expect(log.mock.calls.filter(args => args.includes(`[Muscles] Unknown muscle key: ${key}`))).toEqual([[`[Muscles] Unknown muscle key: ${key}`]]);
    }
  });

  it('also logs unknown keys in a successful zero-score response', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    list([workout('w1', 'zero-unknown')]);
    details('zero-unknown', [score('future_zero_muscle', 0)]);
    expect(await source().getMuscleData(30)).toEqual({
      percentages: {}, source: 'peloton_class_data', workoutsTotal: 1, workoutsWithData: 0,
    });
    expect(log.mock.calls.filter(args => args.includes('[Muscles] Unknown muscle key: future_zero_muscle'))).toEqual([['[Muscles] Unknown muscle key: future_zero_muscle']]);
  });

  it('switches from raw class scores to duration-weighted class shares', async () => {
    const cycling = { ...workout('cycle', 'cycle-30'), duration: 1800, fitness_discipline: 'cycling',
      ride: { id: 'cycle-30', title: '30 min Ride', duration: 1800 } };
    const strength = { ...workout('strength', 'strength-60'), duration: 3600, fitness_discipline: 'strength',
      ride: { id: 'strength-60', title: '60 min Strength', duration: 3600 } };
    list([cycling, strength]);
    details('cycle-30', [score('glutes', 9000), score('quads', 1000)]);
    details('strength-60', [score('core', 900), score('glutes', 100)]);
    const dataSource = source();
    const raw = await dataSource.getMuscleData(30);
    expect(await dataSource.getMuscleData(30, 'raw')).toEqual(raw);
    const perMinute = await dataSource.getMuscleData(30, 'per_minute');
    for (const data of [raw, perMinute]) {
      expect(data.source).toBe('peloton_class_data');
      expect(data.workoutsTotal).toBe(2);
      expect(data.workoutsWithData).toBe(2);
      expect(Object.values(data.percentages).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100);
    }
    expect(raw.percentages.glutes).toBeCloseTo(100 * 9100 / 11000);
    expect(raw.percentages.quads).toBeCloseTo(100 * 1000 / 11000);
    expect(raw.percentages.core).toBeCloseTo(100 * 900 / 11000);
    expect(perMinute.percentages.glutes).toBeCloseTo(100 * 33 / 90);
    expect(perMinute.percentages.quads).toBeCloseTo(100 * 3 / 90);
    expect(perMinute.percentages.core).toBeCloseTo(60);
  });

  it('keeps other in the per-minute denominator and excludes missing class data', async () => {
    list([workout('w1', 'mixed'), workout('w2', 'missing')]);
    details('mixed', [score('core', 1), score('other', 3)]);
    details('missing', []);
    expect(await source().getMuscleData(30, 'per_minute')).toEqual({
      percentages: { core: 25, other: 75 }, source: 'peloton_class_data',
      workoutsTotal: 2, workoutsWithData: 1,
    });
  });

  it('keeps coverage unchanged for a zero-duration scored workout without inventing minutes', async () => {
    list([{ ...workout('w1', 'zero-duration'), duration: 0, ride: { id: 'zero-duration', title: 'Class', duration: 0 } }]);
    details('zero-duration', [score('core', 10)]);
    expect(await source().getMuscleData(30, 'per_minute')).toEqual({
      percentages: {}, source: 'peloton_class_data', workoutsTotal: 1, workoutsWithData: 1,
    });
  });

  it('rejects unsupported weighting before any API request', async () => {
    // @ts-expect-error exercise untyped callers
    await expect(source().getMuscleData(30, 'invalid')).rejects.toThrow(RangeError);
  });

  it('sanitizes and truncates unknown muscle names before logging once', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const name = 'future_é\n\r\t\0\u001b\u2028\u2029\u200b' + 'x'.repeat(60);
    list([workout('w1', 'unsafe-name')]);
    details('unsafe-name', [score(name, 10)]);
    const dataSource = source();
    await dataSource.getMuscleData(30);
    await dataSource.getMuscleData(30);
    const warnings = log.mock.calls.filter(args => String(args[0]).startsWith('[Muscles]'));
    expect(warnings).toEqual([['[Muscles] Unknown muscle key: future_é' + 'x'.repeat(32)]]);
  });

  it('rejects overflowing duplicate sums', () => {
    expect(PelotonMuscleScoresSchema.safeParse([
      score('core', Number.MAX_VALUE), score('core', Number.MAX_VALUE),
    ]).success).toBe(false);
  });

  it('throws at the 25-page limit instead of fetching page 26 or returning a partial window', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'fixture', id: 'user1' });
    let pages = 0;
    for (let page = 0; page < 25; page++) {
      nock(PELOTON_API_URL).get('/api/user/user1/workouts').query(q => q['page'] === String(page))
        .reply(() => {
          pages++;
          return [200, { data: [workout(`w${page}`, `r${page}`)], show_next: true }];
        });
    }
    const result = source().getMuscleData(30);
    await expect(result).rejects.toBeInstanceOf(PelotonApiError);
    await expect(result).rejects.toThrow('Workout pagination exceeded 25 pages');
    expect(pages).toBe(25);
  });

  it.each([
    ['seconds', 30], ['seconds', 60], ['date', 30], ['date', 60],
  ] as const)('honors Retry-After %s at %s seconds', async (format, seconds) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    let retryScheduledAt = 0;
    const log = vi.spyOn(console, 'error').mockImplementation(message => {
      if (String(message).includes('[API] Rate limited.')) retryScheduledAt = Date.now();
    });
    const initial = Date.now();
    const retryAfter = format === 'seconds' ? String(seconds) : new Date(initial + seconds * 1000).toUTCString();
    const expectedDelay = seconds * 1000;
    const scope = nock(PELOTON_API_URL).get('/api/ride/rate-limited/details')
      .reply(429, {}, { 'Retry-After': retryAfter })
      .get('/api/ride/rate-limited/details').reply(200, { ride: { muscle_group_score: [score('core', 1)] } });
    const result = client.getRideMuscleScores('rate-limited');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('[API] Rate limited.')));
    const retryAt = format === 'date' ? Date.parse(retryAfter) : retryScheduledAt + expectedDelay;
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(scope.isDone()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual([score('core', 1)]);
  });

  it.each([
    ['seconds', 61, 'ride'], ['seconds', 120, 'ride'],
    ['date', 61, 'ride'], ['date', 120, 'ride'],
    ['seconds', 61, 'profile'], ['date', 61, 'profile'],
  ] as const)('fails fast for Retry-After %s at %s seconds on %s', async (format, seconds, endpoint) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const retryAfter = format === 'seconds' ? String(seconds) : new Date(NOW + seconds * 1000).toUTCString();
    nock(PELOTON_API_URL).get(endpoint === 'ride' ? '/api/ride/rate-limited/details' : '/api/me')
      .reply(429, {}, { 'Retry-After': retryAfter });
    const result = endpoint === 'ride' ? client.getRideMuscleScores('rate-limited') : client.getUserProfile();
    await expect(result).rejects.toBeInstanceOf(PelotonRateLimitError);
    await expect(result).rejects.toMatchObject({ status: 429, retryAfterMs: seconds * 1000 });
    expect(Date.now()).toBe(NOW);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('[API] Rate limited. Retrying'));
  });
});
