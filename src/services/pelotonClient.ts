import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import {
  PELOTON_API_URL,
  MAX_RETRIES,
  INITIAL_RETRY_DELAY,
  MAX_RETRY_DELAY,
  DEFAULT_CACHE_TTL,
} from '../constants.js';
import { CacheItem, PelotonUserProfile, PelotonWorkout, WorkoutSearchParams } from '../types/index.js';
import { isError, PelotonApiError, PelotonAuthError, PelotonRateLimitError } from '../types/errors.js';
import { upsertWorkout, getRecentWorkoutsFromDB, getWorkoutCount } from '../db/queries.js';
import {
  PelotonMeResponseSchema,
  PelotonWorkoutResponseSchema,
  PelotonWorkoutsListResponseSchema,
} from '../schemas/api.js';
import { loadToken, saveToken, isTokenExpired, PelotonAuthToken } from './tokenStore.js';
import { refreshToken } from './pelotonAuth.js';

type PelotonWorkoutResponse = (typeof PelotonWorkoutResponseSchema)['_output'];

const cache = new Map<string, CacheItem<unknown>>();

function getEndpoint(config: AxiosRequestConfig): string {
  const url = config.url ?? 'unknown-endpoint';

  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function parseRetryAfterMs(retryAfter: string | null | undefined): number {
  if (!retryAfter) {
    return INITIAL_RETRY_DELAY;
  }

  const asSeconds = Number(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const targetMs = Date.parse(retryAfter);
  if (Number.isFinite(targetMs)) {
    return Math.max(0, targetMs - Date.now());
  }

  return INITIAL_RETRY_DELAY;
}

function getRetryAfterHeaderValue(axiosError: AxiosError): string | undefined {
  const retryAfter = axiosError.response?.headers?.['retry-after'];
  return typeof retryAfter === 'string' ? retryAfter : undefined;
}

function mapWorkout(rawWorkout: PelotonWorkoutResponse): PelotonWorkout {
  const normalizedDuration = rawWorkout.ride?.duration ?? rawWorkout.duration ?? 0;
  const instructor = rawWorkout.ride?.instructor ?? rawWorkout.instructor;
  const ride = rawWorkout.ride
    ? {
        title: rawWorkout.ride.title ?? rawWorkout.name ?? 'Untitled Workout',
        duration: normalizedDuration,
        ...(rawWorkout.ride.instructor ? { instructor: rawWorkout.ride.instructor } : {}),
      }
    : undefined;

  return {
    id: rawWorkout.id,
    name: rawWorkout.ride?.title ?? rawWorkout.name ?? 'Untitled Workout',
    duration: normalizedDuration,
    created_at: rawWorkout.created_at,
    calories: rawWorkout.calories ?? 0,
    fitness_discipline: rawWorkout.fitness_discipline,
    ...(instructor ? { instructor } : {}),
    ...(rawWorkout.total_work !== undefined ? { total_work: rawWorkout.total_work } : {}),
    ...(rawWorkout.device_type !== undefined ? { device_type: rawWorkout.device_type } : {}),
    ...(rawWorkout.status !== undefined ? { status: rawWorkout.status } : {}),
    ...(ride ? { ride } : {}),
  };
}

/**
 * Makes an API request with retry logic for rate limiting and caching.
 */
async function makeApiRequest<T>(
  config: AxiosRequestConfig,
  retries = 0,
  cacheKey?: string,
  cacheTTL = DEFAULT_CACHE_TTL
): Promise<T> {
  const endpoint = getEndpoint(config);

  if (cacheKey) {
    const cachedValue = cache.get(cacheKey);
    if (cachedValue && cachedValue.expiry > Date.now()) {
      console.error(`[Cache] Hit for: ${cacheKey}`);
      // Safe cast because cache entries are only written by this function for the same cache key.
      return cachedValue.data as T;
    }
  }

  try {
    console.error(`[API] ${config.method?.toUpperCase()} ${config.url}`);
    const response = await axios<T>(config);

    if (cacheKey) {
      cache.set(cacheKey, {
        data: response.data,
        expiry: Date.now() + cacheTTL,
      });
      console.error(`[Cache] Stored: ${cacheKey}`);
    }

    return response.data;
  } catch (error: unknown) {
    if (error instanceof PelotonApiError) {
      throw error;
    }

    const axiosError = error instanceof AxiosError ? error : null;
    const status = axiosError?.response?.status;

    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        axiosError ? getRetryAfterHeaderValue(axiosError) : undefined
      );

      if (retries < MAX_RETRIES) {
        const retryDelay = Math.min(
          Math.max(retryAfterMs, INITIAL_RETRY_DELAY) * Math.pow(2, retries),
          MAX_RETRY_DELAY
        );

        console.error(
          `[API] Rate limited. Retrying in ${retryDelay}ms (Attempt ${retries + 1}/${MAX_RETRIES})`
        );

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        return makeApiRequest<T>(config, retries + 1, cacheKey, cacheTTL);
      }

      throw new PelotonRateLimitError(endpoint, retryAfterMs);
    }

    if (axiosError?.response) {
      const responseStatus = axiosError.response.status;
      const responseBody =
        typeof axiosError.response.data === 'string'
          ? axiosError.response.data
          : JSON.stringify(axiosError.response.data);
      throw new PelotonApiError(
        `Peloton API error ${responseStatus}: ${responseBody}`,
        responseStatus,
        endpoint
      );
    }

    if (isError(error)) {
      throw new PelotonApiError(error.message, 0, endpoint);
    }

    throw new PelotonApiError('Unknown API request failure', 0, endpoint);
  }
}

export class PelotonClient {
  private sessionCookie: string | null;
  private bearerToken: string | null;
  private userId?: string;
  private cachedToken: PelotonAuthToken | null = null;

  constructor(credential: string) {
    if (credential.startsWith('eyJ')) {
      this.bearerToken = credential;
      this.sessionCookie = null;
    } else {
      this.sessionCookie = credential;
      this.bearerToken = null;
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'User-Agent': 'PelotonMCP/1.0',
      Accept: 'application/json',
      'peloton-platform': 'web',
    };

    // 1. Try to load token from tokenStore
    let token = this.cachedToken || await loadToken();

    // 2. If token exists and NOT expired, use it
    if (token && !isTokenExpired(token)) {
      if (token.token_type === 'Bearer') {
        headers['Authorization'] = `Bearer ${token.access_token}`;
      } else {
        headers['Cookie'] = `peloton_session_id=${token.access_token}`;
      }
      this.cachedToken = token;
      return headers;
    }

    // 3. If token exists but expired, attempt refresh
    if (token && isTokenExpired(token)) {
      console.error('[Client] Token expired, attempting refresh...');
      const username = process.env.PELOTON_USERNAME;
      const password = process.env.PELOTON_PASSWORD;

      const refreshedToken = await refreshToken(token, username, password);
      if (refreshedToken) {
        await saveToken(refreshedToken);
        this.cachedToken = refreshedToken;

        if (refreshedToken.token_type === 'Bearer') {
          headers['Authorization'] = `Bearer ${refreshedToken.access_token}`;
        } else {
          headers['Cookie'] = `peloton_session_id=${refreshedToken.access_token}`;
        }
        return headers;
      }

      console.error('[Client] Token refresh failed, falling back to constructor credential');
    }

    // 4. If no token, fall back to cookie/bearer from constructor
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    } else if (this.sessionCookie) {
      headers['Cookie'] = `peloton_session_id=${this.sessionCookie}`;
    }

    return headers;
  }

  /**
   * Test the connection and get user ID.
   */
  async testConnection(): Promise<{ success: boolean; details: string; userId?: string }> {
    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: `${PELOTON_API_URL}/api/me`,
        headers: await this.getAuthHeaders(),
      };

      const response = await makeApiRequest<unknown>(config);
      const parsed = PelotonMeResponseSchema.safeParse(response);

      if (!parsed.success) {
        throw new PelotonApiError(
          `Invalid /api/me response: ${parsed.error.message}`,
          200,
          '/api/me'
        );
      }

      this.userId = parsed.data.id;
      return {
        success: true,
        details: `Connected as user: ${parsed.data.username}`,
        userId: parsed.data.id,
      };
    } catch (error: unknown) {
      return {
        success: false,
        details: `Failed to connect: ${isError(error) ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Get recent workouts.
   */
  async getRecentWorkouts(limit = 10): Promise<PelotonWorkout[]> {
    if (!this.userId) {
      const connectionTest = await this.testConnection();
      if (!connectionTest.success || !connectionTest.userId) {
        throw new PelotonAuthError('Could not get user ID - please check authentication');
      }
      this.userId = connectionTest.userId;
    }

    const cacheKey = `workouts_${this.userId}_${limit}`;
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: `${PELOTON_API_URL}/api/user/${this.userId}/workouts`,
      params: {
        limit,
        page: 0,
        joins: 'ride,ride.instructor',
        sort_by: '-created',
      },
      headers: await this.getAuthHeaders(),
    };

    const response = await makeApiRequest<unknown>(config, 0, cacheKey);
    const parsed = PelotonWorkoutsListResponseSchema.safeParse(response);

    if (!parsed.success) {
      throw new PelotonApiError(
        `Invalid workouts response: ${parsed.error.message}`,
        200,
        `/api/user/${this.userId}/workouts`
      );
    }

    const workouts = parsed.data.data.map(mapWorkout);

    for (const workout of workouts) {
      try {
        upsertWorkout(workout);
      } catch (error: unknown) {
        console.error(
          `[DB] Failed to store workout ${workout.id}:`,
          isError(error) ? error.message : 'Unknown error'
        );
      }
    }

    return workouts;
  }

  /**
   * Get workouts directly from database (faster, offline-capable).
   */
  getWorkoutsFromDB(limit = 10): PelotonWorkout[] {
    return getRecentWorkoutsFromDB(limit);
  }

  /**
   * Get user profile information.
   */
  async getUserProfile(): Promise<PelotonUserProfile> {
    const cacheKey = `profile_${this.userId ?? 'unknown'}`;
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: `${PELOTON_API_URL}/api/me`,
      headers: await this.getAuthHeaders(),
    };

    const response = await makeApiRequest<unknown>(config, 0, cacheKey);
    const parsed = PelotonMeResponseSchema.safeParse(response);

    if (!parsed.success) {
      throw new PelotonApiError(`Invalid /api/me response: ${parsed.error.message}`, 200, '/api/me');
    }

    this.userId = parsed.data.id;
    const profile: PelotonUserProfile = {
      id: parsed.data.id,
      username: parsed.data.username,
      ...(parsed.data.total_workouts !== undefined
        ? { total_workouts: parsed.data.total_workouts }
        : {}),
      ...(parsed.data.total_followers !== undefined
        ? { total_followers: parsed.data.total_followers }
        : {}),
      ...(parsed.data.total_following !== undefined
        ? { total_following: parsed.data.total_following }
        : {}),
      ...(parsed.data.created_at !== undefined ? { created_at: parsed.data.created_at } : {}),
    };
    return profile;
  }

  /**
   * Search workouts by filters.
   * Checks DB first, falls back to API if DB is empty or data is stale.
   */
  async searchWorkouts(params: WorkoutSearchParams): Promise<PelotonWorkout[]> {
    if (!this.userId) {
      await this.testConnection();
    }

    const dbCount = getWorkoutCount();
    let workouts: PelotonWorkout[];

    const now = Math.floor(Date.now() / 1000);
    const thirtyMinAgo = now - 1800;

    if (dbCount > 0 && (!params.startDate || params.startDate.getTime() / 1000 < thirtyMinAgo)) {
      console.error(`[DB] Using database for workout search (${dbCount} workouts cached)`);
      workouts = this.getWorkoutsFromDB(params.limit ?? 50);
    } else {
      workouts = await this.getRecentWorkouts(params.limit ?? 50);
    }

    let filtered = workouts;

    if (params.discipline) {
      const disciplineFilter = params.discipline.toLowerCase();
      filtered = filtered.filter(
        (workout) => workout.fitness_discipline.toLowerCase() === disciplineFilter
      );
    }

    if (params.instructor) {
      const instructorFilter = params.instructor.toLowerCase();
      filtered = filtered.filter((workout) =>
        (workout.ride?.instructor?.name ?? workout.instructor?.name ?? '')
          .toLowerCase()
          .includes(instructorFilter)
      );
    }

    if (params.startDate) {
      const startTimestamp = Math.floor(params.startDate.getTime() / 1000);
      filtered = filtered.filter((workout) => workout.created_at >= startTimestamp);
    }

    if (params.endDate) {
      const endTimestamp = Math.floor(params.endDate.getTime() / 1000);
      filtered = filtered.filter((workout) => workout.created_at <= endTimestamp);
    }

    return filtered;
  }

  /**
   * Clear cache.
   */
  static clearCache(): void {
    cache.clear();
    console.error('[Cache] Cleared all cached data');
  }
}
