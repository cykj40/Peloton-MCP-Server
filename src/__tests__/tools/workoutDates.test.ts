import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { PELOTON_API_URL } from '../../constants.js';
import { upsertWorkout } from '../../db/queries.js';
import { PelotonClient } from '../../services/pelotonClient.js';
import { saveToken } from '../../services/tokenStore.js';
import { handleWorkoutTool } from '../../tools/workouts.js';
import { handleAnalyticsTool } from '../../tools/analytics.js';
import { makeMockWorkout } from '../fixtures.js';
import { setupTestDb, teardownTestDb } from '../testDb.js';

const NOW = Date.parse('2026-10-09T03:59:59Z'); // Still October 8 in New York; already October 9 in UTC.
const fixtures = [
  ['eight-days-ago', '2026-09-30T14:00:00Z'],
  ['six-days-ago', '2026-10-02T14:00:00Z'],
  ['yesterday', '2026-10-07T14:00:00Z'],
  ['before-start', '2026-10-08T03:59:59Z'],
  ['start-boundary', '2026-10-08T04:00:00Z'],
  ['today-ride', '2026-10-08T14:00:00Z'],
  ['new-york-2330', '2026-10-09T03:30:00Z'],
  ['last-second', '2026-10-09T03:59:59Z'],
  ['exclusive-end', '2026-10-09T04:00:00Z'],
].map(([id, iso]) => makeMockWorkout({ id: id!, created_at: Date.parse(iso!) / 1000 }));
const todayIds = ['last-second', 'new-york-2330', 'today-ride', 'start-boundary'];

describe.each(['peloton_get_workouts', 'peloton_workout_stats'] as const)('%s calendar-date regression', tool => {
  let client: PelotonClient;
  let recent: ReturnType<typeof vi.spyOn>;
  let search: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await setupTestDb();
    PelotonClient.clearCache(); nock.cleanAll();
    await saveToken({ access_token: 'eyJ.date.fixture', token_type: 'Bearer', user_id: 'date-user', expires_at: NOW + 10 * 86400000 });
    for (const workout of fixtures) await upsertWorkout(workout);
    nock(PELOTON_API_URL).persist().get('/api/me').reply(200, { id: 'date-user', username: 'fixture' });
    nock(PELOTON_API_URL).persist().get('/api/user/date-user/workouts')
      .query({ limit: 100, page: 0, joins: 'ride,ride.instructor', sort_by: '-created' })
      .reply(200, { data: [...fixtures].reverse(), total: fixtures.length, show_next: false });
    client = new PelotonClient('eyJ.date.fixture');
    recent = vi.spyOn(client, 'getRecentWorkouts');
    search = vi.spyOn(client, 'searchWorkouts');
  });
  afterEach(async () => {
    nock.cleanAll(); vi.restoreAllMocks(); vi.useRealTimers(); await teardownTestDb();
  });
  async function call(dates: { start_date?: string; end_date?: string } = {}) {
    const args = { ...dates, response_format: 'json' as const };
    const response = tool === 'peloton_get_workouts'
      ? await handleWorkoutTool(tool, { ...args, limit: 100 }, client)
      : await handleAnalyticsTool(tool, args, client);
    const first = response.content[0];
    if (!first || first.type !== 'text') throw Error('Missing tool text');
    return first.text;
  }
  async function expectWorkouts(dates: { start_date?: string; end_date?: string }, ids: string[]) {
    const result = JSON.parse(await call(dates));
    expect(result.total_workouts).toBe(ids.length);
    if (tool === 'peloton_get_workouts') expect(result.workouts.map((workout: { id: string }) => workout.id)).toEqual(ids);
    else if (ids.length) {
      const selected = fixtures.filter(workout => ids.includes(workout.id));
      expect(result.period_start).toBe(new Date(Math.min(...selected.map(workout => workout.created_at)) * 1000).toISOString());
      expect(result.period_end).toBe(new Date(Math.max(...selected.map(workout => workout.created_at)) * 1000).toISOString());
    }
  }
  it('replays start_date = end_date = today, including 23:30 New York on the next UTC day', async () => {
    await expectWorkouts({ start_date: '2026-10-08', end_date: '2026-10-08' }, todayIds);
  });
  it('includes today in the last seven calendar days, with inclusive start and exclusive end', async () => {
    await expectWorkouts({ start_date: '2026-10-02', end_date: '2026-10-08' }, [...todayIds, 'before-start', 'yesterday', 'six-days-ago']);
  });
  it('supports a start-only filter at local midnight', async () => {
    await expectWorkouts({ start_date: '2026-10-08' }, ['exclusive-end', ...todayIds]);
  });
  it('supports an end-only filter through the last second of the local day', async () => {
    await expectWorkouts({ end_date: '2026-10-08' }, [...todayIds, 'before-start', 'yesterday', 'six-days-ago', 'eight-days-ago']);
  });
  it('keeps unfiltered results and the existing stats fetch limit', async () => {
    await expectWorkouts({}, [...fixtures].reverse().map(workout => workout.id));
    if (tool === 'peloton_workout_stats') expect(recent).toHaveBeenCalledExactlyOnceWith(100);
  });
  it('uses explicit timed inputs as exact instants, including the given end instant', async () => {
    await expectWorkouts({ start_date: '2026-10-08T10:00:00-04:00', end_date: '2026-10-08T10:00:00-04:00' }, ['today-ride']);
  });
  it('does not floor a fractional timed start or expand a timed end to a whole day', async () => {
    await expectWorkouts({ start_date: '2026-10-08T14:00:00.500Z', end_date: '2026-10-09T03:30:00Z' }, ['new-york-2330']);
  });
  it.each(['2026-02-31', '2026-02-29', '2026-13-01', '2026-04-31', '2026-02-31T12:00:00Z'])('rejects invalid calendar date %s before fetching', async value => {
    expect(await call({ start_date: value })).toContain(`Invalid calendar date: ${value}`);
    expect(recent).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
  });
  it.each([
    { start_date: '2026-10-09', end_date: '2026-10-08' },
    { start_date: '2026-10-08T14:00:00Z', end_date: '2026-10-08T13:59:59Z' },
    { start_date: '2026-10-09T04:00:00Z', end_date: '2026-10-08' },
  ])('rejects reversed range %j before fetching', async dates => {
    expect(await call(dates)).toContain('start_date must not be after end_date');
    expect(recent).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
  });
  it.each([
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'], // 23-hour spring day.
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'], // 25-hour fall day.
  ])('includes both DST boundaries correctly on %s', async (day, start, end) => {
    const startSeconds = Date.parse(start) / 1000, endSeconds = Date.parse(end) / 1000;
    const dst = [
      makeMockWorkout({ id: 'before', created_at: startSeconds - 1 }),
      makeMockWorkout({ id: 'first', created_at: startSeconds }),
      makeMockWorkout({ id: 'last', created_at: endSeconds - 1 }),
      makeMockWorkout({ id: 'next', created_at: endSeconds }),
    ];
    // Use the real in-memory DB search; only the API response is stubbed for stats.
    const { getDatabase } = await import('../../db/database.js');
    await getDatabase().execute('DELETE FROM workouts');
    for (const workout of dst) await upsertWorkout(workout);
    recent.mockRestore();
    vi.spyOn(client, 'getRecentWorkouts').mockResolvedValue([...dst].reverse());
    vi.setSystemTime(Date.parse(end) + 3600000);
    const result = JSON.parse(await call({ start_date: day, end_date: day }));
    expect(result.total_workouts).toBe(2);
    if (tool === 'peloton_get_workouts') expect(result.workouts.map((workout: { id: string }) => workout.id)).toEqual(['last', 'first']);
    else { expect(result.period_start).toBe(start.replace('Z', '.000Z')); expect(result.period_end).toBe(new Date((endSeconds - 1) * 1000).toISOString()); }
  });
});
