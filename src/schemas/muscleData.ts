import { z } from 'zod';

export const PelotonMuscleScoresSchema = z.array(z.object({
  muscle_group: z.string(),
  score: z.number().finite().nonnegative(),
}).passthrough()).transform(scores => {
  const merged = new Map<string, (typeof scores)[number]>();
  for (const entry of scores) {
    const previous = merged.get(entry.muscle_group);
    if (previous) previous.score += entry.score;
    else merged.set(entry.muscle_group, { ...entry });
  }
  return [...merged.values()];
}).refine(scores => scores.every(entry => Number.isFinite(entry.score)), {
  message: 'Summed muscle scores must be finite',
});

export const RideMuscleDetailsSchema = z.object({
  ride: z.object({
    muscle_group_score: PelotonMuscleScoresSchema.nullish(),
  }),
});
