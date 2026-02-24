import nock from 'nock';
import { PELOTON_API_URL } from '../constants.js';
import { getWorkoutById, getWorkoutCount, upsertWorkout } from '../db/queries.js';
import { PelotonClient } from '../services/pelotonClient.js';
import { makeMockWorkout } from './fixtures.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

describe('PelotonClient', () => {
  beforeEach(() => {
    setupTestDb();
    PelotonClient.clearCache();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
    teardownTestDb();
  });

  it('testConnection success path', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');

    const result = await client.testConnection();

    expect(result.success).toBe(true);
    expect(result.userId).toBe('user123');
  });

  it('testConnection failure path', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(401, { message: 'unauthorized' });
    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');

    const result = await client.testConnection();

    expect(result.success).toBe(false);
  });

  it('getRecentWorkouts maps and stores workouts in DB', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    nock(PELOTON_API_URL)
      .get('/api/user/user123/workouts')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'workout-1',
            fitness_discipline: 'cycling',
            duration: 1800,
            created_at: 1_700_000_000,
            calories: 320,
            ride: {
              title: 'Ride Title',
              duration: 1800,
              instructor: { name: 'Alex', id: 'i1' },
            },
          },
        ],
      });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const workouts = await client.getRecentWorkouts(10);

    expect(workouts).toHaveLength(1);
    expect(workouts[0]?.name).toBe('Ride Title');
    expect(getWorkoutCount()).toBe(1);
    expect(getWorkoutById('workout-1')?.instructor?.name).toBe('Alex');
  });

  it('getRecentWorkouts retries after rate limit', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    nock(PELOTON_API_URL)
      .get('/api/user/user123/workouts')
      .query(true)
      .reply(429, { message: 'rate limit' }, { 'retry-after': '0' })
      .get('/api/user/user123/workouts')
      .query(true)
      .reply(200, { data: [] });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const workouts = await client.getRecentWorkouts(10);

    expect(workouts).toEqual([]);
  });

  it('getUserProfile returns mapped profile', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, {
      username: 'testuser',
      id: 'user123',
      total_workouts: 10,
      total_followers: 20,
      total_following: 30,
    });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const profile = await client.getUserProfile();

    expect(profile.username).toBe('testuser');
    expect(profile.total_workouts).toBe(10);
  });

  it('searchWorkouts applies discipline filtering on DB data', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    upsertWorkout(makeMockWorkout({ id: 'c1', fitness_discipline: 'cycling' }));
    upsertWorkout(makeMockWorkout({ id: 's1', fitness_discipline: 'strength' }));

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const result = await client.searchWorkouts({ discipline: 'cycling', limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]?.fitness_discipline).toBe('cycling');
  });

  it('cache behavior avoids repeated HTTP for same workouts endpoint', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    const workoutsScope = nock(PELOTON_API_URL)
      .get('/api/user/user123/workouts')
      .query(true)
      .once()
      .reply(200, { data: [] });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    await client.getRecentWorkouts(5);
    await client.getRecentWorkouts(5);

    expect(workoutsScope.isDone()).toBe(true);
  });

  it('searchWorkouts fetches from API when DB is empty', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    nock(PELOTON_API_URL)
      .get('/api/user/user123/workouts')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'workout-api',
            fitness_discipline: 'running',
            duration: 1200,
            created_at: 1_700_000_000,
            calories: 250,
          },
        ],
      });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const result = await client.searchWorkouts({ discipline: 'running', limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('workout-api');
  });

  it('searchWorkouts filters by endDate', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    upsertWorkout(makeMockWorkout({ id: 'old', created_at: 1_600_000_000 }));
    upsertWorkout(makeMockWorkout({ id: 'new', created_at: 1_700_000_000 }));

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const endDate = new Date(1_650_000_000 * 1000);
    const result = await client.searchWorkouts({ endDate, limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('old');
  });

  it('searchWorkouts filters by instructor', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    upsertWorkout(
      makeMockWorkout({
        id: 'alex-ride',
        instructor: { id: 'i1', name: 'Alex' },
      })
    );
    upsertWorkout(
      makeMockWorkout({
        id: 'robin-ride',
        instructor: { id: 'i2', name: 'Robin' },
      })
    );

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const result = await client.searchWorkouts({ instructor: 'Alex', limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('alex-ride');
  });

  it('getUserProfile skips testConnection when userId is already set', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, {
      username: 'testuser',
      id: 'user123',
      total_workouts: 5,
    });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');

    // First call sets userId
    await client.testConnection();

    // Second call should skip testConnection
    const profile = await client.getUserProfile();

    expect(profile.username).toBe('testuser');
    expect(profile.total_workouts).toBe(5);
  });

  it('throws error when constructing client with non-JWT credential', () => {
    expect(() => new PelotonClient('not-a-jwt-token')).toThrow(
      'PelotonClient only accepts JWT Bearer tokens'
    );
  });
});
