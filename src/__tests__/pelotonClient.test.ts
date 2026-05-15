import nock from 'nock';
import { PELOTON_API_URL } from '../constants.js';
import { getWorkoutById, getWorkoutCount, upsertWorkout } from '../db/queries.js';
import { PelotonClient } from '../services/pelotonClient.js';
import { makeMockWorkout } from './fixtures.js';
import { setupTestDb, teardownTestDb } from './testDb.js';

describe('PelotonClient', () => {
  let originalEnvBearerToken: string | undefined;
  let originalEnvSessionCookie: string | undefined;
  let originalEnvUsername: string | undefined;
  let originalEnvPassword: string | undefined;

  beforeEach(async () => {
    originalEnvBearerToken = process.env.PELOTON_BEARER_TOKEN;
    originalEnvSessionCookie = process.env.PELOTON_SESSION_COOKIE;
    originalEnvUsername = process.env.PELOTON_USERNAME;
    originalEnvPassword = process.env.PELOTON_PASSWORD;
    delete process.env.PELOTON_BEARER_TOKEN;
    delete process.env.PELOTON_SESSION_COOKIE;
    delete process.env.PELOTON_USERNAME;
    delete process.env.PELOTON_PASSWORD;
    await setupTestDb();
    PelotonClient.clearCache();
    nock.cleanAll();
  });

  afterEach(async () => {
    if (originalEnvBearerToken !== undefined) {
      process.env.PELOTON_BEARER_TOKEN = originalEnvBearerToken;
    } else {
      delete process.env.PELOTON_BEARER_TOKEN;
    }
    if (originalEnvSessionCookie !== undefined) {
      process.env.PELOTON_SESSION_COOKIE = originalEnvSessionCookie;
    } else {
      delete process.env.PELOTON_SESSION_COOKIE;
    }
    if (originalEnvUsername !== undefined) {
      process.env.PELOTON_USERNAME = originalEnvUsername;
    } else {
      delete process.env.PELOTON_USERNAME;
    }
    if (originalEnvPassword !== undefined) {
      process.env.PELOTON_PASSWORD = originalEnvPassword;
    } else {
      delete process.env.PELOTON_PASSWORD;
    }
    nock.cleanAll();
    await teardownTestDb();
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
    expect(await getWorkoutCount()).toBe(1);
    expect((await getWorkoutById('workout-1'))?.instructor?.name).toBe('Alex');
  });

  it('getRecentWorkouts sends peloton_session_id cookie when available', async () => {
    process.env.PELOTON_SESSION_COOKIE = 'session-cookie-123';

    nock(PELOTON_API_URL)
      .get('/api/me')
      .matchHeader('authorization', 'Bearer eyJhbGciOiJSUzI1NiJ9.fake.token')
      .reply(200, { username: 'testuser', id: 'user123' });

    nock(PELOTON_API_URL)
      .get('/api/user/user123/workouts')
      .query(true)
      .matchHeader('cookie', 'peloton_session_id=session-cookie-123')
      .reply(200, { data: [] });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const workouts = await client.getRecentWorkouts(10);

    expect(workouts).toEqual([]);
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
    await upsertWorkout(makeMockWorkout({ id: 'c1', fitness_discipline: 'cycling' }));
    await upsertWorkout(makeMockWorkout({ id: 's1', fitness_discipline: 'strength' }));

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
    await upsertWorkout(makeMockWorkout({ id: 'old', created_at: 1_600_000_000 }));
    await upsertWorkout(makeMockWorkout({ id: 'new', created_at: 1_700_000_000 }));

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const endDate = new Date(1_650_000_000 * 1000);
    const result = await client.searchWorkouts({ endDate, limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('old');
  });

  it('searchWorkouts filters by instructor', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    await upsertWorkout(
      makeMockWorkout({
        id: 'alex-ride',
        instructor: { id: 'i1', name: 'Alex' },
      })
    );
    await upsertWorkout(
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
    nock(PELOTON_API_URL)
      .get('/api/me')
      .twice()
      .reply(200, {
        username: 'testuser',
        id: 'user123',
        total_workouts: 5,
      });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');

    await client.testConnection();
    const profile = await client.getUserProfile();

    expect(profile.username).toBe('testuser');
    expect(profile.total_workouts).toBe(5);
  });

  it('throws error when constructing client with non-JWT credential', () => {
    expect(() => new PelotonClient('not-a-jwt-token')).toThrow(
      'PelotonClient only accepts JWT Bearer tokens'
    );
  });

  it('searchWorkouts handles startDate filter', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    await upsertWorkout(makeMockWorkout({ id: 'old-workout', created_at: 1_600_000_000 }));
    await upsertWorkout(makeMockWorkout({ id: 'new-workout', created_at: 1_700_000_000 }));

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const startDate = new Date(1_650_000_000 * 1000);
    const result = await client.searchWorkouts({ startDate, limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('new-workout');
  });

  it('getRecentWorkouts throws error when response schema is invalid', async () => {
    nock(PELOTON_API_URL).get('/api/me').reply(200, { username: 'testuser', id: 'user123' });
    nock(PELOTON_API_URL)
      .get('/api/user/user123/workouts')
      .query(true)
      .reply(200, { invalid: 'response' });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    await expect(client.getRecentWorkouts(10)).rejects.toThrow('Invalid workouts response');
  });

  it('getUserProfile throws error when response schema is invalid', async () => {
    nock(PELOTON_API_URL)
      .get('/api/me')
      .reply(200, { invalid: 'profile' });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    await expect(client.getUserProfile()).rejects.toThrow('Invalid /api/me response');
  });

  it('testConnection returns success false and throws error on invalid schema', async () => {
    nock(PELOTON_API_URL)
      .get('/api/me')
      .reply(200, { invalid: 'response' });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const result = await client.testConnection();

    expect(result.success).toBe(false);
    expect(result.details).toContain('Invalid /api/me response');
  });

  it('getRecentWorkouts throws error when testConnection fails', async () => {
    nock(PELOTON_API_URL)
      .get('/api/me')
      .reply(401, { error: 'unauthorized' });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    await expect(client.getRecentWorkouts(10)).rejects.toThrow('Could not get user ID');
  });

  it('auto-retries on 401 when PELOTON_USERNAME and PELOTON_PASSWORD are set', async () => {
    process.env.PELOTON_USERNAME = 'user@example.com';
    process.env.PELOTON_PASSWORD = 'secret';

    nock(PELOTON_API_URL)
      .get('/api/me')
      .reply(401, { message: 'unauthorized' });

    nock(PELOTON_API_URL)
      .post('/auth/login', { username_or_email: 'user@example.com', password: 'secret' })
      .reply(200, { user_id: 'user123' }, { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.new.token' });

    nock(PELOTON_API_URL)
      .get('/api/me')
      .reply(200, { username: 'testuser', id: 'user123' });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const result = await client.testConnection();

    expect(result.success).toBe(true);
    expect(result.userId).toBe('user123');
  });

  it('does not retry on 401 when credentials are not set', async () => {
    nock(PELOTON_API_URL)
      .get('/api/me')
      .reply(401, { message: 'unauthorized' });

    const client = new PelotonClient('eyJhbGciOiJSUzI1NiJ9.fake.token');
    const result = await client.testConnection();

    expect(result.success).toBe(false);
    expect(result.details).toContain('401');
  });
});
