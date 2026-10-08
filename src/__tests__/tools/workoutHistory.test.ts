import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { DEFAULT_CACHE_TTL, PELOTON_API_URL } from '../../constants.js';
import { PelotonClient } from '../../services/pelotonClient.js';
import { saveToken } from '../../services/tokenStore.js';
import { handleAnalyticsTool } from '../../tools/analytics.js';
import { makeMockWorkout } from '../fixtures.js';
import { setupTestDb, teardownTestDb } from '../testDb.js';

const NOW = Date.parse('2026-10-08T16:00:00Z');
const DAY = 86400000;
const START = new Date(NOW - 90 * DAY);
const TOKEN = 'eyJ.history.fixture';
const history = (count: number) => Array.from({ length: count }, (_, i) => makeMockWorkout({
  id: `w-${i}`, created_at: (NOW - (i / Math.max(count, 1)) * 89 * DAY) / 1000,
}));

describe('paginated workout statistics', () => {
  let client: PelotonClient;
  let requested: number[];
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    await setupTestDb(); PelotonClient.clearCache(); nock.cleanAll(); requested = [];
    await saveToken({ access_token: TOKEN, token_type: 'Bearer', user_id: 'history-user', expires_at: NOW + 10 * DAY });
    nock(PELOTON_API_URL).get('/api/me').reply(200, { id: 'history-user', username: 'fixture' });
    client = new PelotonClient(TOKEN);
  });
  afterEach(async () => {
    nock.cleanAll(); vi.restoreAllMocks(); vi.useRealTimers(); await teardownTestDb();
  });
  function api(reply: (page: number) => object) {
    nock(PELOTON_API_URL).persist().get('/api/user/history-user/workouts')
      .query(q => q['limit'] === '100' && q['sort_by'] === '-created')
      .reply(200, uri => {
        const page = Number(new URL(uri, PELOTON_API_URL).searchParams.get('page'));
        requested.push(page); return reply(page);
      });
  }
  const stats = (dates: { start_date?: string; end_date?: string } = {
    start_date: START.toISOString(), end_date: new Date(NOW).toISOString(),
  }, format = 'json') => handleAnalyticsTool('peloton_workout_stats', { ...dates, response_format: format }, client);
  const count = (result: Awaited<ReturnType<typeof stats>>) => JSON.parse(result.content[0]!.text!).total_workouts;

  it.each([135, 200, 0])('counts all %i workouts, including an exactly full final page and empty history', async size => {
    const workouts = history(size);
    api(page => ({ data: workouts.slice(page * 100, (page + 1) * 100), show_next: (page + 1) * 100 < size }));
    expect(count(await stats())).toBe(size);
    expect(requested).toEqual(size > 100 ? [0, 1] : [0]);
  });
  it.each(['total', 'page_count', 'none'])('handles a full final page with %s pagination metadata', async metadata => {
    const workouts = history(200);
    api(page => ({ data: workouts.slice(page * 100, (page + 1) * 100),
      ...(metadata === 'total' ? { total: 200 } : metadata === 'page_count' ? { page_count: 2 } : {}),
    }));
    expect(count(await stats())).toBe(200);
    expect(requested).toEqual(metadata === 'none' ? [0, 1, 2] : [0, 1]);
  });
  it('keeps unfiltered history unbounded by age, and paginates it', async () => {
    const workouts = history(135).map((w, i) => ({ ...w, created_at: (NOW - i * DAY) / 1000 }));
    api(page => ({ data: workouts.slice(page * 100, (page + 1) * 100), total: 135 }));
    expect(count(await stats({}))).toBe(135);
    expect(requested).toEqual([0, 1]);
  });
  it('stops on the page crossing the start boundary without fetching older pages', async () => {
    const workouts = [...history(135), makeMockWorkout({ id: 'older', created_at: START.getTime() / 1000 - 1 })];
    api(page => ({ data: workouts.slice(page * 100, (page + 1) * 100), show_next: true }));
    expect((await client.getWorkoutsInWindow(START, new Date(NOW))).length).toBe(135);
    expect(requested).toEqual([0, 1]);
  });
  it('stops immediately on an empty page even when the API claims more pages', async () => {
    api(() => ({ data: [], show_next: true }));
    expect(count(await stats())).toBe(0); expect(requested).toEqual([0]);
  });
  it.each(['json', 'markdown'])('bounds an endless full-page API and reports partial totals (%s)', async format => {
    api(page => ({ data: history(100).map((w, i) => ({ ...w, id: `page-${page}-${i}` })), show_next: true }));
    const result = await stats(undefined, format);
    expect(requested).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(result.content.map(c => c.text ?? '').join('\n')).toMatch(/partial data.*25 pages.*incomplete/i);
    if (format === 'json') {
      expect(count(result)).toBe(2500);
      expect(result.structuredContent).toEqual(JSON.parse(result.content[0]!.text!));
    } else expect(result.content[0]!.text).toContain('**Total Workouts:** 2500');
  }, 15000);
  it('still fails closed for chart callers that require complete history', async () => {
    api(page => ({ data: [makeMockWorkout({ id: `page-${page}`, created_at: NOW / 1000 })], show_next: true }));
    await expect(client.getWorkoutsInWindow(START, new Date(NOW))).rejects.toThrow('25 pages');
    expect(requested).toHaveLength(25);
  });
  it('reports partial data instead of looping when a page repeats', async () => {
    api(() => ({ data: history(100), show_next: true }));
    const result = await stats();
    expect(count(result)).toBe(100);
    expect(result.content.map(c => c.text ?? '').join('\n')).toMatch(/partial data.*no progress.*incomplete/i);
    expect(requested).toEqual([0, 1]);
  });
  it('caches all pages for five minutes and fetches them again at expiry', async () => {
    const workouts = history(135);
    api(page => ({ data: workouts.slice(page * 100, (page + 1) * 100), total: 135 }));
    expect(count(await stats())).toBe(135);
    vi.setSystemTime(NOW + DEFAULT_CACHE_TTL - 1);
    expect(count(await stats())).toBe(135); expect(requested).toEqual([0, 1]);
    vi.setSystemTime(NOW + DEFAULT_CACHE_TTL);
    expect(count(await stats())).toBe(135); expect(requested).toEqual([0, 1, 0, 1]);
  });
});
