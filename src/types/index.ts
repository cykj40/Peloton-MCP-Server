export interface PelotonWorkout {
  id: string;
  name: string;
  duration: number; // seconds
  created_at: number; // Unix timestamp - CRITICAL for glucose correlation
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

// Glucose correlation types
export interface GlucoseReading {
  value: number;
  recordedAt: string; // ISO 8601 timestamp
}

export interface GlucoseCorrelation {
  id?: number;
  workout_id: string;
  workout_timestamp: number;
  discipline: string;
  duration_seconds: number;
  pre_workout_glucose: number | null;
  glucose_at_start: number | null;
  glucose_nadir: number | null;
  glucose_nadir_time: number | null; // minutes after workout start
  glucose_4h_post: number | null;
  avg_drop: number | null;
  recovery_time_minutes: number | null;
  notes: string | null;
  analyzed_at?: string;
}

export interface DisciplineInsight {
  discipline: string;
  avg_drop: number;
  avg_nadir_time: number;
  avg_recovery_time: number;
  sample_count: number;
  risk_level: 'low' | 'moderate' | 'high';
  avg_pre_workout: number;
  avg_nadir: number;
}

export interface MuscleSnapshot {
  id?: number;
  period: '7_days' | '30_days' | '90_days';
  calculated_at: string;
  muscle_data: MuscleGroupData;
  workout_count: number;
}

export interface HypoglycemiaAlert {
  workout_id: string;
  discipline: string;
  workout_timestamp: number;
  glucose_nadir: number;
  nadir_time_minutes: number;
  severity: 'mild' | 'moderate' | 'severe';
  is_delayed: boolean; // true if nadir > 2 hours post-workout
  notes: string;
}
