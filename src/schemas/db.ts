import { z } from 'zod';

export const CountRowSchema = z.object({
  count: z.number(),
});

export const StoredPelotonWorkoutSchema = z.object({
  id: z.string(),
  name: z.string(),
  duration: z.number(),
  created_at: z.number(),
  calories: z.number(),
  fitness_discipline: z.string(),
  instructor: z
    .object({
      name: z.string(),
      id: z.string(),
    })
    .optional(),
  total_work: z.number().optional(),
  device_type: z.string().optional(),
  status: z.string().optional(),
  ride: z
    .object({
      title: z.string(),
      duration: z.number(),
      instructor: z
        .object({
          name: z.string(),
          id: z.string(),
        })
        .optional(),
    })
    .optional(),
});

export const MuscleSnapshotRowSchema = z.object({
  id: z.number(),
  period: z.union([z.literal('7_days'), z.literal('30_days'), z.literal('90_days')]),
  calculated_at: z.string(),
  muscle_data: z.string(),
  workout_count: z.number(),
});

export const GlucoseCorrelationSchema = z.object({
  id: z.number().optional(),
  workout_id: z.string(),
  workout_timestamp: z.number(),
  discipline: z.string(),
  duration_seconds: z.number(),
  pre_workout_glucose: z.number().nullable(),
  glucose_at_start: z.number().nullable(),
  glucose_nadir: z.number().nullable(),
  glucose_nadir_time: z.number().nullable(),
  glucose_4h_post: z.number().nullable(),
  avg_drop: z.number().nullable(),
  recovery_time_minutes: z.number().nullable(),
  notes: z.string().nullable(),
  analyzed_at: z.string().optional(),
});
