import { z } from 'zod';

export const WorkoutSearchSchema = z.object({
  limit: z.number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Number of workouts to fetch"),

  discipline: z.string()
    .optional()
    .describe("Filter by discipline"),

  instructor: z.string()
    .optional()
    .describe("Filter by instructor name"),

  start_date: z.string()
    .optional()
    .describe("Start date (YYYY-MM-DD) for glucose correlation"),

  end_date: z.string()
    .optional()
    .describe("End date (YYYY-MM-DD)"),

  response_format: z.enum(['markdown', 'json'])
    .default('markdown')
}).strict();

export const MuscleAnalysisSchema = z.object({
  period: z.enum(['7_days', '30_days', '90_days'])
    .default('7_days')
    .describe("Time period to analyze"),

  response_format: z.enum(['markdown', 'json'])
    .default('markdown')
}).strict();

export const WorkoutStatsSchema = z.object({
  start_date: z.string()
    .optional()
    .describe("Start date (YYYY-MM-DD)"),

  end_date: z.string()
    .optional()
    .describe("End date (YYYY-MM-DD)"),

  response_format: z.enum(['markdown', 'json'])
    .default('markdown')
}).strict();

export const ConnectionTestSchema = z.object({}).strict();

export const ProfileSchema = z.object({
  response_format: z.enum(['markdown', 'json'])
    .default('markdown')
}).strict();

export const GlucoseReadingSchema = z.object({
  value: z.number(),
  recordedAt: z.string().optional(),
  recorded_at: z.string().optional(),
}).strict().refine(
  (value) => typeof value.recordedAt === 'string' || typeof value.recorded_at === 'string',
  { message: 'Each glucose reading must include recordedAt or recorded_at' }
);

export const GlucoseCorrelationAnalysisSchema = z.object({
  workout_id: z.string(),
  glucose_readings: z.array(GlucoseReadingSchema),
  response_format: z.enum(['markdown', 'json']).default('markdown'),
}).strict();

export const CorrelationResponseSchema = z.object({
  response_format: z.enum(['markdown', 'json']).default('markdown'),
}).strict();

export const SyncWorkoutsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
