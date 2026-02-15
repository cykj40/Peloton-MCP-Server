export interface PelotonWorkout {
  id: string;
  name: string;
  duration: number; // seconds
  created_at: number; // Unix timestamp
  calories: number;
  fitness_discipline: string;
  instructor?: {
    name: string;
    id: string;
  };
  total_work?: number;
  device_type?: string;
  status?: string;
  ride?: {
    title: string;
    duration: number;
    instructor?: {
      name: string;
      id: string;
    };
  };
}

export interface PelotonUser {
  id: string;
  username: string;
  email?: string;
  total_workouts?: number;
  total_following?: number;
  total_followers?: number;
  created_at?: number;
}

export interface MuscleGroupData {
  [muscle: string]: number; // percentage
}

export interface MuscleImpactData {
  [muscle: string]: {
    score: number;
    workouts: number;
  };
}

export interface WorkoutStats {
  total_workouts: number;
  total_duration: number; // seconds
  total_calories: number;
  avg_duration: number;
  avg_calories: number;
  disciplines: {
    [discipline: string]: number;
  };
  period_start: string;
  period_end: string;
}

export interface CacheItem {
  data: unknown;
  expiry: number;
}

export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}
