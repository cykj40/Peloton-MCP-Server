import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { PELOTON_API_URL } from '../constants.js';
import { getWorkoutCount } from '../db/queries.js';
import { PelotonClient } from '../services/pelotonClient.js';
import { saveToken } from '../services/tokenStore.js';
import { PelotonApiError, PelotonAuthError } from '../types/errors.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

const START = new Date('2026-09-03T20:00:00.000Z');
const END = new Date('2026-10-03T20:00:00.000Z');
const scores: Record<string, number> = {
  glutes: 45178, hamstrings: 45178, quads: 45178, calves: 43378, hips: 43378,
  core: 41505, obliques: 40903, low_back: 40453, mid_back: 39699,
  biceps: 39541, chest: 39541, forearms: 39541, triceps: 39541,
  lats: 39018, shoulders: 39018, traps: 39018,
};
const sample = Object.entries(scores).map(([muscle_group, score]) => ({
  muscle_group, score,
  percentage: ['glutes', 'hamstrings', 'quads', 'calves'].includes(muscle_group) ? 7 : 6,
  bucket: 1,
})).reverse();

function request() {
  return nock(PELOTON_API_URL).get('/api/user/body-user/workouts').query({
    from: START.toISOString(), to: END.toISOString(),
    stats_from: START.toISOString(), stats_to: END.toISOString(), joins: 'ride',
  });
}

describe('PelotonClient.getBodyActivity', () => {
  let client: PelotonClient;
  beforeEach(async () => {
    await setupTestDb();
    PelotonClient.clearCache();
    nock.cleanAll();
    const fixtureToken = 'eyJhbGciOiJSUzI1NiJ9.body.fixture';
    await saveToken({ access_token: fixtureToken, token_type: 'Bearer', user_id: 'body-user', expires_at: Date.now() + 7 * 86_400_000 });
    client = new PelotonClient(fixtureToken);
  });
  afterEach(async () => {
    const pending = nock.pendingMocks();
    nock.cleanAll();
    vi.restoreAllMocks();
    await teardownTestDb();
    expect(pending).toEqual([]);
  });

  it('uses one GET and API percentages to reproduce the real top six and Other 60', async () => {
    request().reply(200, { muscle_group_score: sample });
    const result = await client.getBodyActivity(START, END);
    expect(result.percentages).toEqual(Object.fromEntries(sample.map(entry => [entry.muscle_group, entry.percentage])));
    expect(Object.values(result.percentages).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(result.topSix.map(entry => entry.muscle_group)).toEqual(['glutes', 'hamstrings', 'quads', 'calves', 'hips', 'core']);
    expect(result.topSix.map(entry => entry.percentage)).toEqual([7, 7, 7, 7, 6, 6]);
    expect(result.topSix.map(entry => entry.score)).toEqual([45178, 45178, 45178, 43378, 43378, 41505]);
    expect(result.other).toBe(60);
    // These percentages are authoritative, not recomputed from the raw scores.
    expect(result.percentages.glutes).toBe(7);
    expect(await getWorkoutCount()).toBe(0);
  });

  it('discards nested workouts and extra fields, logs none of them, and never caches the response', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const marker = 'private-workout-payload-never-retain';
    request().reply(200, {
      muscle_group_score: sample.map(entry => ({ ...entry, extra: marker, display_name: marker })),
      data: [{ id: marker, ride: { muscle_group_score: [{ muscle_group: 'biceps', score: 999999, percentage: 100, bucket: 3 }] } }],
      summary: marker,
    });
    const first = await client.getBodyActivity(START, END);
    expect(first.topSix).toHaveLength(6);
    for (const entry of first.topSix) expect(Object.keys(entry).sort()).toEqual(['bucket', 'muscle_group', 'percentage', 'score']);
    expect(JSON.stringify(first)).not.toContain(marker);
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(output.mock.calls)).not.toContain(marker);
    expect(await getWorkoutCount()).toBe(0);
    request().reply(200, { muscle_group_score: [{ muscle_group: 'core', score: 10, percentage: 100, bucket: 3 }] });
    const second = await client.getBodyActivity(START, END);
    expect(second.percentages).toEqual({ core: 100 });
    expect(second.other).toBe(0);
    expect(await getWorkoutCount()).toBe(0);
  });

  it('does not fall back to nested class muscle data when the top-level array is absent', async () => {
    request().reply(200, { data: [{ ride: { muscle_group_score: sample } }] });
    await expect(client.getBodyActivity(START, END)).rejects.toThrow('Invalid body activity response');
  });

  it('does not expose workout payloads in HTTP errors', async () => {
    const marker = 'private-error-workout-payload';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    request().reply(500, { data: [{ id: marker }], error: marker });
    const error = await client.getBodyActivity(START, END).catch(error => error);
    expect(error).toBeInstanceOf(PelotonApiError);
    expect(error.status).toBe(500);
    expect(error.message).not.toContain(marker);
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
    expect(await getWorkoutCount()).toBe(0);
  });

  it.each([
    [new Date('invalid'), END], [START, new Date('invalid')], [END, START],
  ])('rejects an invalid window before requesting data', async (start, end) => {
    await expect(client.getBodyActivity(start, end)).rejects.toThrow(RangeError);
  });

  it('does not perform an extra GET to discover a missing user id', async () => {
    await saveToken({ access_token: 'eyJhbGciOiJSUzI1NiJ9.unknown.fixture', token_type: 'Bearer', user_id: 'unknown', expires_at: Date.now() + 7 * 86_400_000 });
    await expect(client.getBodyActivity(START, END)).rejects.toBeInstanceOf(PelotonAuthError);
  });

  it('handles an empty top-level array without using unrelated workouts', async () => {
    request().reply(200, { muscle_group_score: [], data: [{ ride: { muscle_group_score: sample } }] });
    expect(await client.getBodyActivity(START, END)).toEqual({ percentages: {}, topSix: [], other: 100 });
  });
});
