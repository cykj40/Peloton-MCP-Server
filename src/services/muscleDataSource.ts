import { calculateMuscleImpact } from './analytics.js';
import type { PelotonClient } from './pelotonClient.js';
import { RideMuscleCache, rideMuscleCache } from './rideMuscleCache.js';
import { PELOTON_MUSCLE_KEYS } from '../types/muscleData.js';
import type { MuscleData, MuscleDataSource, MusclePercentages, PelotonMuscleKey, PelotonMuscleScore } from '../types/muscleData.js';
import type { PelotonWorkout } from '../types/index.js';

type MuscleClient = Pick<PelotonClient, 'getWorkoutsInWindow' | 'getRideMuscleScores'>;

const loggedUnknownMuscles = new Set<string>();

function muscleKey(key: string): PelotonMuscleKey {
  const known = PELOTON_MUSCLE_KEYS.find(muscle => muscle === key);
  if (known) return known;
  if (!loggedUnknownMuscles.has(key)) {
    loggedUnknownMuscles.add(key);
    console.error(key);
  }
  return 'other';
}


/** Compatibility aliases for the legacy estimate, not a chart-region mapping.
 * Its broad back/upper_back categories are approximated as mid_back. No score is invented.
 */
const ESTIMATE_ALIASES: Readonly<Record<string, PelotonMuscleKey>> = {
  quadriceps: 'quads', lower_back: 'low_back', back: 'mid_back', upper_back: 'mid_back',
};

function estimatePercentages(workouts: PelotonWorkout[]): MusclePercentages {
  const impact = calculateMuscleImpact(workouts);
  const total = Object.values(impact).reduce((sum, entry) => sum + entry.score, 0);
  const percentages: MusclePercentages = {};
  if (total <= 0) return percentages;
  for (const [key, entry] of Object.entries(impact)) {
    const muscle = ESTIMATE_ALIASES[key] ?? PELOTON_MUSCLE_KEYS.find(k => k === key);
    if (muscle) percentages[muscle] = (percentages[muscle] ?? 0) + 100 * entry.score / total;
  }
  return percentages;
}

export class PelotonClassMuscleDataSource implements MuscleDataSource {
  constructor(
    private readonly client: MuscleClient,
    private readonly cache: RideMuscleCache = rideMuscleCache,
    private readonly now: () => number = Date.now,
  ) {}

  async getMuscleData(days: number): Promise<MuscleData> {
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new RangeError('days must be an integer from 1 to 90');
    }
    const end = this.now();
    const start = end - days * 86_400_000;
    const fetched = await this.client.getWorkoutsInWindow(new Date(start), new Date(end));
    const workouts = [...new Map(fetched
      .filter(w => w.created_at * 1000 >= start && w.created_at * 1000 <= end)
      .map(w => [w.id, w])).values()];
    const rideIds = [...new Set(workouts.flatMap(w => w.ride?.id ? [w.ride.id] : []))];
    const scoresByRide = new Map<string, PelotonMuscleScore[]>();
    await Promise.all(rideIds.map(async rideId => {
      try {
        const scores = await this.cache.get(rideId, () => this.client.getRideMuscleScores(rideId));
        scoresByRide.set(rideId, scores.map(entry => ({
          ...entry, muscle_group: muscleKey(entry.muscle_group),
        })));
      } catch {
        // Failed rides reduce coverage. Never blend estimates into successful class data.
      }
    }));

    if (workouts.length > 0 && scoresByRide.size === 0) {
      return { percentages: estimatePercentages(workouts), source: 'estimate', workoutsTotal: workouts.length, workoutsWithData: 0 };
    }

    const totals: MusclePercentages = {};
    let totalScore = 0;
    let workoutsWithData = 0;
    for (const workout of workouts) {
      const scores = workout.ride?.id ? scoresByRide.get(workout.ride.id) : undefined;
      if (!scores?.some(s => s.score > 0)) continue;
      workoutsWithData += 1;
      // Each performance counts, even when the class metadata was fetched only once.
      for (const { muscle_group, score } of scores) {
        const key = muscleKey(muscle_group);
        totals[key] = (totals[key] ?? 0) + score;
        totalScore += score;
      }
    }
    const percentages: MusclePercentages = {};
    if (totalScore > 0) {
      for (const key of PELOTON_MUSCLE_KEYS) {
        if (totals[key] !== undefined) percentages[key] = 100 * totals[key] / totalScore;
      }
    }
    return { percentages, source: 'peloton_class_data', workoutsTotal: workouts.length, workoutsWithData };
  }
}
