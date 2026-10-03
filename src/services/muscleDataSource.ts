import { calculateMuscleImpact } from './analytics.js';
import { impactToPelotonPercentages } from './musclePercentages.js';
import type { PelotonClient } from './pelotonClient.js';
import { RideMuscleCache, rideMuscleCache } from './rideMuscleCache.js';
import { PELOTON_MUSCLE_KEYS } from '../types/muscleData.js';
import type { MuscleData, MuscleDataSource, MusclePercentages, MuscleWeighting, PelotonMuscleKey, PelotonMuscleScore } from '../types/muscleData.js';

type MuscleClient = Pick<PelotonClient, 'getWorkoutsInWindow' | 'getRideMuscleScores'>;

const loggedUnknownMuscles = new Set<string>();

function muscleKey(key: string): PelotonMuscleKey {
  const known = PELOTON_MUSCLE_KEYS.find(muscle => muscle === key);
  if (known) return known;
  if (!loggedUnknownMuscles.has(key)) {
    loggedUnknownMuscles.add(key);
    const name = [...key.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')].slice(0, 40).join('');
    console.error(`[Muscles] Unknown muscle key: ${name}`);
  }
  return 'other';
}


export class PelotonClassMuscleDataSource implements MuscleDataSource {
  constructor(
    private readonly client: MuscleClient,
    private readonly cache: RideMuscleCache = rideMuscleCache,
    private readonly now: () => number = Date.now,
  ) {}

  async getMuscleData(days: number, weighting: MuscleWeighting = 'raw'): Promise<MuscleData> {
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new RangeError('days must be an integer from 1 to 90');
    }
    if (weighting !== 'raw' && weighting !== 'per_minute') {
      throw new RangeError('weighting must be raw or per_minute');
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
      return { percentages: impactToPelotonPercentages(calculateMuscleImpact(workouts)), source: 'estimate', workoutsTotal: workouts.length, workoutsWithData: 0 };
    }

    const totals: MusclePercentages = {};
    let totalScore = 0;
    let workoutsWithData = 0;
    for (const workout of workouts) {
      const scores = workout.ride?.id ? scoresByRide.get(workout.ride.id) : undefined;
      if (!scores?.some(s => s.score > 0)) continue;
      workoutsWithData += 1;
      // Each performance counts, even when the class metadata was fetched only once.
      const classTotal = scores.reduce((sum, entry) => sum + entry.score, 0);
      const minutes = Number.isFinite(workout.duration) ? Math.max(0, workout.duration / 60) : 0;
      const factor = weighting === 'per_minute' ? minutes / classTotal : 1;
      for (const { muscle_group, score } of scores) {
        const key = muscleKey(muscle_group);
        const weightedScore = score * factor;
        totals[key] = (totals[key] ?? 0) + weightedScore;
        totalScore += weightedScore;
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
