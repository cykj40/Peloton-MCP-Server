import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import {
  PELOTON_API_URL,
  MAX_RETRIES,
  INITIAL_RETRY_DELAY,
  MAX_RETRY_DELAY,
  DEFAULT_CACHE_TTL,
} from '../constants.js';
import { CacheItem, PelotonWorkout } from '../types/index.js';
import { upsertWorkout, getRecentWorkoutsFromDB, getWorkoutCount } from '../db/queries.js';

// In-memory cache
const cache: Record<string, CacheItem> = {};

/**
 * Makes an API request with retry logic for rate limiting and caching
 */
async function makeApiRequest<T>(
  config: AxiosRequestConfig,
  retries = 0,
  cacheKey?: string,
  cacheTTL = DEFAULT_CACHE_TTL
): Promise<T> {
  // Check cache
  if (cacheKey && cache[cacheKey] && cache[cacheKey].expiry > Date.now()) {
    console.error(`[Cache] Hit for: ${cacheKey}`);
    return cache[cacheKey].data as T;
  }

  try {
    console.error(`[API] ${config.method?.toUpperCase()} ${config.url}`);
    const response = await axios(config);

    // Cache the response
    if (cacheKey) {
      cache[cacheKey] = {
        data: response.data,
        expiry: Date.now() + cacheTTL,
      };
      console.error(`[Cache] Stored: ${cacheKey}`);
    }

    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError;

    // Handle rate limiting (HTTP 429) with exponential backoff
    if (axiosError.response?.status === 429 && retries < MAX_RETRIES) {
      const retryDelay = Math.min(
        INITIAL_RETRY_DELAY * Math.pow(2, retries),
        MAX_RETRY_DELAY
      );

      console.error(
        `[API] Rate limited. Retrying in ${retryDelay}ms (Attempt ${retries + 1}/${MAX_RETRIES})`
      );

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return makeApiRequest<T>(config, retries + 1, cacheKey, cacheTTL);
    }

    // Handle other errors
    if (axiosError.response) {
      console.error(`[API] Error ${axiosError.response.status}:`, axiosError.response.data);
    } else {
      console.error(`[API] Error:`, axiosError.message);
    }

    throw error;
  }
}

export class PelotonClient {
  private sessionCookie: string;
  private userId?: string;

  constructor(sessionCookie: string) {
    this.sessionCookie = sessionCookie;
  }

  /**
   * Test the connection and get user ID
   */
  async testConnection(): Promise<{ success: boolean; details: string; userId?: string }> {
    try {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: `${PELOTON_API_URL}/api/me`,
        headers: {
          Cookie: `peloton_session_id=${this.sessionCookie}`,
          'User-Agent': 'PelotonMCP/1.0',
          Accept: 'application/json',
          'peloton-platform': 'web',
        },
      };

      const response = await makeApiRequest<{ username: string; id: string }>(config);

      if (response && response.username) {
        this.userId = response.id;
        return {
          success: true,
          details: `Connected as user: ${response.username}`,
          userId: response.id,
        };
      }

      return {
        success: false,
        details: 'Could not verify connection',
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      return {
        success: false,
        details: `Failed to connect: ${axiosError.message}`,
      };
    }
  }

  /**
   * Get recent workouts
   */
  async getRecentWorkouts(limit: number = 10): Promise<any[]> {
    // Ensure we have a user ID
    if (!this.userId) {
      const connectionTest = await this.testConnection();
      if (!connectionTest.success || !connectionTest.userId) {
        throw new Error('Could not get user ID - please check authentication');
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
      headers: {
        Cookie: `peloton_session_id=${this.sessionCookie}`,
        'User-Agent': 'PelotonMCP/1.0',
        Accept: 'application/json',
        'peloton-platform': 'web',
      },
    };

    const response = await makeApiRequest<{ data: any[] }>(config, 0, cacheKey);
    const workouts = response.data || [];

    // Store workouts in database for correlation analysis
    for (const workout of workouts) {
      try {
        const mappedWorkout: PelotonWorkout = {
          id: workout.id,
          name: workout.ride?.title || workout.name || 'Untitled Workout',
          duration: workout.ride?.duration || workout.duration || 0,
          created_at: workout.created_at,
          calories: workout.calories || 0,
          fitness_discipline: workout.fitness_discipline,
          instructor: workout.ride?.instructor || workout.instructor,
          total_work: workout.total_work,
          device_type: workout.device_type,
          status: workout.status,
          ride: workout.ride,
        };
        upsertWorkout(mappedWorkout);
      } catch (error) {
        console.error(`[DB] Failed to store workout ${workout.id}:`, error);
      }
    }

    return workouts;
  }

  /**
   * Get workouts directly from database (faster, offline-capable)
   */
  getWorkoutsFromDB(limit: number = 10): PelotonWorkout[] {
    return getRecentWorkoutsFromDB(limit);
  }

  /**
   * Get user profile information
   */
  async getUserProfile(): Promise<any> {
    const cacheKey = `profile_${this.userId}`;
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: `${PELOTON_API_URL}/api/me`,
      headers: {
        Cookie: `peloton_session_id=${this.sessionCookie}`,
        'User-Agent': 'PelotonMCP/1.0',
        Accept: 'application/json',
        'peloton-platform': 'web',
      },
    };

    const response = await makeApiRequest<any>(config, 0, cacheKey);

    if (response && response.id) {
      this.userId = response.id;
    }

    return response;
  }

  /**
   * Search workouts by filters
   * Checks DB first, falls back to API if DB is empty or data is stale
   */
  async searchWorkouts(params: {
    discipline?: string;
    instructor?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<any[]> {
    if (!this.userId) {
      await this.testConnection();
    }

    // Check if we have data in DB
    const dbCount = getWorkoutCount();
    let workouts: any[];

    // Use DB for historical data (older than 30 min), API for recent data
    const now = Math.floor(Date.now() / 1000);
    const thirtyMinAgo = now - 1800;

    if (dbCount > 0 && (!params.startDate || params.startDate.getTime() / 1000 < thirtyMinAgo)) {
      // Use DB for older data
      console.error(`[DB] Using database for workout search (${dbCount} workouts cached)`);
      workouts = this.getWorkoutsFromDB(params.limit || 50);
    } else {
      // Use API for recent data or if DB is empty
      workouts = await this.getRecentWorkouts(params.limit || 50);
    }

    let filtered = workouts;

    if (params.discipline) {
      filtered = filtered.filter(
        (w) => w.fitness_discipline?.toLowerCase() === params.discipline?.toLowerCase()
      );
    }

    if (params.instructor) {
      filtered = filtered.filter((w) =>
        w.ride?.instructor?.name?.toLowerCase().includes(params.instructor!.toLowerCase())
      );
    }

    if (params.startDate) {
      const startTimestamp = Math.floor(params.startDate.getTime() / 1000);
      filtered = filtered.filter((w) => w.created_at >= startTimestamp);
    }

    if (params.endDate) {
      const endTimestamp = Math.floor(params.endDate.getTime() / 1000);
      filtered = filtered.filter((w) => w.created_at <= endTimestamp);
    }

    return filtered;
  }

  /**
   * Clear cache
   */
  static clearCache(): void {
    Object.keys(cache).forEach((key) => delete cache[key]);
    console.error('[Cache] Cleared all cached data');
  }
}
