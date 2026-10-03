import { z } from 'zod';
import { PELOTON_MUSCLE_KEYS } from '../types/muscleData.js';

export const PelotonMuscleScoresSchema = z.array(z.object({
  muscle_group: z.enum(PELOTON_MUSCLE_KEYS),
  score: z.number().finite().nonnegative(),
  percentage: z.number().finite().min(0).max(100),
  bucket: z.number().int().min(1).max(3),
  display_name: z.string(),
})).refine(scores => new Set(scores.map(s => s.muscle_group)).size === scores.length, {
  message: 'Duplicate muscle keys',
});

export const RideMuscleDetailsSchema = z.object({
  ride: z.object({
    muscle_group_score: PelotonMuscleScoresSchema.nullish(),
  }),
});
