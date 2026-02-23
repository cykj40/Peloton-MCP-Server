import { z } from 'zod';

export const PelotonInstructorSchema = z.object({
  name: z.string(),
  id: z.string(),
});

export const PelotonMeResponseSchema = z.object({
  username: z.string(),
  id: z.string(),
  total_workouts: z.number().optional(),
  total_followers: z.number().optional(),
  total_following: z.number().optional(),
  created_at: z.number().optional(),
});

export const PelotonWorkoutResponseSchema = z.object({
  id: z.string(),
  fitness_discipline: z.string(),
  duration: z.number(),
  created_at: z.number(),
  total_work: z.number().optional(),
  calories: z.number().optional(),
  status: z.string().optional(),
  ride: z.object({
    title: z.string().optional(),
    duration: z.number().optional(),
    instructor: PelotonInstructorSchema.optional(),
  }).optional(),
  instructor: PelotonInstructorSchema.optional(),
  name: z.string().optional(),
  device_type: z.string().optional(),
});

export const PelotonWorkoutsListResponseSchema = z.object({
  data: z.array(PelotonWorkoutResponseSchema),
  total: z.number().optional(),
});
