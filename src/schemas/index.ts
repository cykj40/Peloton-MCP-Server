import { z } from 'zod';
import { workoutDateInputError, WORKOUT_START_DATE_DESCRIPTION, WORKOUT_END_DATE_DESCRIPTION } from '../utils/workoutDates.js';

const DateStringSchema = z.string().superRefine((value, ctx) => {
  const error = workoutDateInputError(value);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

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

  start_date: DateStringSchema
    .optional()
    .describe(WORKOUT_START_DATE_DESCRIPTION),

  end_date: DateStringSchema
    .optional()
    .describe(WORKOUT_END_DATE_DESCRIPTION),

  response_format: z.enum(['markdown', 'json'])
    .default('markdown'),

  json_response: z.boolean().optional().default(false),
}).strict();

export const MuscleAnalysisSchema = z.object({
  period: z.enum(['7_days', '30_days', '90_days'])
    .default('7_days')
    .describe("Time period to analyze"),

  response_format: z.enum(['markdown', 'json'])
    .default('markdown')
}).strict();

export const WorkoutStatsSchema = z.object({
  start_date: DateStringSchema
    .optional()
    .describe(WORKOUT_START_DATE_DESCRIPTION),

  end_date: DateStringSchema
    .optional()
    .describe(WORKOUT_END_DATE_DESCRIPTION),

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
  json_response: z.boolean().optional().default(false),
}).strict();

export const SyncWorkoutsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const MuscleActivityChartSchema = z.object({
  days: z.number().int().min(1).max(90).default(7),
  weighting: z.enum(['raw', 'per_minute']).default('raw'),
}).strict();
