import { PelotonWorkout, MuscleGroupData, MuscleImpactData, WorkoutStats } from '../types/index.js';
import { Discipline, MUSCLE_INTENSITY_MAP } from '../constants.js';

function isDiscipline(value: string): value is Discipline {
  return value in MUSCLE_INTENSITY_MAP;
}

/**
 * Get muscle intensity map for a workout
 * For strength workouts, detects focus from title keywords
 */
export function getMuscleIntensity(
  discipline: Discipline,
  workoutTitle: string = ''
): Record<string, number> {
  const lowerDiscipline = discipline;
  const lowerTitle = workoutTitle.toLowerCase();

  // Get base mapping
  const baseMapping = MUSCLE_INTENSITY_MAP[lowerDiscipline];

  if (!baseMapping) {
    return { full_body: 5 };
  }

  // For strength, detect specific focus from title
  if (lowerDiscipline === 'strength') {
    if (lowerTitle.includes('upper body') || lowerTitle.includes('arms') ||
        lowerTitle.includes('chest') || lowerTitle.includes('back')) {
      return {
        core: 6,
        chest: 8,
        shoulders: 8,
        triceps: 9,
        biceps: 9,
        back: 7,
      };
    } else if (lowerTitle.includes('lower body') || lowerTitle.includes('legs') ||
               lowerTitle.includes('glutes')) {
      return {
        core: 6,
        quadriceps: 9,
        hamstrings: 9,
        glutes: 8,
        calves: 6,
      };
    } else if (lowerTitle.includes('core') || lowerTitle.includes('abs')) {
      return {
        core: 10,
        lower_back: 6,
        obliques: 8,
      };
    } else {
      // Full body strength
      return {
        chest: 6,
        back: 6,
        shoulders: 6,
        biceps: 6,
        triceps: 6,
        core: 7,
        quadriceps: 6,
        hamstrings: 6,
        glutes: 6,
      };
    }
  }

  return baseMapping;
}

/**
 * Calculate muscle impact from workouts
 */
export function calculateMuscleImpact(workouts: PelotonWorkout[]): MuscleImpactData {
  const muscleGroups: MuscleImpactData = {};

  for (const workout of workouts) {
    const disciplineKey = workout.fitness_discipline.toLowerCase();
    const muscleIntensities = isDiscipline(disciplineKey)
      ? getMuscleIntensity(disciplineKey, workout.name || workout.ride?.title || '')
      : (() => {
          console.error(
            `[Analytics] Unknown discipline "${workout.fitness_discipline}", using full-body fallback`
          );
          return { full_body: 5 };
        })();

    // Duration factor: longer workouts = higher impact
    const durationMinutes = workout.duration / 60;
    const intensityFactor = Math.min(1, durationMinutes / 30);

    for (const [muscle, intensity] of Object.entries(muscleIntensities)) {
      if (!muscleGroups[muscle]) {
        muscleGroups[muscle] = { score: 0, workouts: 0 };
      }

      const group = muscleGroups[muscle];
      if (!group) {
        continue;
      }

      group.score += intensity * intensityFactor;
      group.workouts += 1;
    }
  }

  return muscleGroups;
}

/**
 * Calculate muscle activity percentages (for charts)
 */
export function calculateMuscleActivity(
  workouts: PelotonWorkout[],
  period: '7_days' | '30_days' | '90_days'
): MuscleGroupData {
  // Calculate date range
  const days = period === '7_days' ? 7 : period === '30_days' ? 30 : 90;
  const now = Date.now();
  const startTimestamp = Math.floor((now - days * 24 * 60 * 60 * 1000) / 1000);

  // Filter workouts by period
  const filteredWorkouts = workouts.filter(w => w.created_at >= startTimestamp);

  if (filteredWorkouts.length === 0) {
    return {};
  }

  // Get muscle impact
  const muscleImpact = calculateMuscleImpact(filteredWorkouts);

  // Calculate total score
  const totalScore = Object.values(muscleImpact).reduce((sum, m) => sum + m.score, 0);

  if (totalScore === 0) {
    return {};
  }

  // Convert to percentages, exclude non-visual muscles
  const excludedMuscles = ['heart', 'mind', 'lungs', 'full_body'];
  const musclePercentages: MuscleGroupData = {};

  for (const [muscle, data] of Object.entries(muscleImpact)) {
    if (!excludedMuscles.includes(muscle)) {
      musclePercentages[formatMuscleName(muscle)] = Math.round((data.score / totalScore) * 100);
    }
  }

  return musclePercentages;
}

/**
 * Calculate workout statistics
 */
export function calculateWorkoutStats(
  workouts: PelotonWorkout[],
  startDate?: Date,
  endDate?: Date
): WorkoutStats {
  let filtered = workouts;

  // Filter by date range
  if (startDate) {
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    filtered = filtered.filter(w => w.created_at >= startTimestamp);
  }
  if (endDate) {
    const endTimestamp = Math.floor(endDate.getTime() / 1000);
    filtered = filtered.filter(w => w.created_at <= endTimestamp);
  }

  // Calculate totals
  const totalWorkouts = filtered.length;
  const totalDuration = filtered.reduce((sum, w) => sum + w.duration, 0);
  const totalCalories = filtered.reduce((sum, w) => sum + (w.calories || 0), 0);

  // Calculate averages
  const avgDuration = totalWorkouts > 0 ? totalDuration / totalWorkouts : 0;
  const avgCalories = totalWorkouts > 0 ? totalCalories / totalWorkouts : 0;

  // Group by discipline
  const disciplines: Record<string, number> = {};
  for (const workout of filtered) {
    const discipline = workout.fitness_discipline;
    const currentCount = disciplines[discipline] ?? 0;
    disciplines[discipline] = currentCount + 1;
  }

  // Get date range
  const timestamps = filtered.map(w => w.created_at).sort((a, b) => a - b);
  const firstTimestamp = timestamps[0];
  const lastTimestamp = timestamps[timestamps.length - 1];
  const periodStart = firstTimestamp !== undefined
    ? new Date(firstTimestamp * 1000).toISOString()
    : new Date().toISOString();
  const periodEnd = lastTimestamp !== undefined
    ? new Date(lastTimestamp * 1000).toISOString()
    : new Date().toISOString();

  return {
    total_workouts: totalWorkouts,
    total_duration: totalDuration,
    total_calories: totalCalories,
    avg_duration: Math.round(avgDuration),
    avg_calories: Math.round(avgCalories),
    disciplines,
    period_start: periodStart,
    period_end: periodEnd,
  };
}

/**
 * Analyze training balance
 */
export function analyzeTrainingBalance(muscleImpact: MuscleImpactData): {
  upperBody: number;
  lowerBody: number;
  balanced: boolean;
  cardioScore: number;
  strengthScore: number;
} {
  const upperBodyMuscles = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'upper_back'];
  const lowerBodyMuscles = ['quadriceps', 'hamstrings', 'calves', 'glutes'];

  let upperBodyScore = 0;
  let lowerBodyScore = 0;
  let cardioScore = 0;
  let strengthScore = 0;

  for (const [muscle, data] of Object.entries(muscleImpact)) {
    if (upperBodyMuscles.includes(muscle)) {
      upperBodyScore += data.score;
      strengthScore += data.score;
    } else if (lowerBodyMuscles.includes(muscle)) {
      lowerBodyScore += data.score;
      strengthScore += data.score;
    } else if (muscle === 'heart' || muscle === 'lungs') {
      cardioScore += data.score;
    }
  }

  const totalBodyScore = upperBodyScore + lowerBodyScore;
  const upperBodyPercentage = totalBodyScore > 0 ? Math.round((upperBodyScore / totalBodyScore) * 100) : 0;
  const lowerBodyPercentage = totalBodyScore > 0 ? Math.round((lowerBodyScore / totalBodyScore) * 100) : 0;

  // Balanced if within 60/40 to 40/60 range
  const balanced = upperBodyPercentage >= 40 && upperBodyPercentage <= 60;

  return {
    upperBody: upperBodyPercentage,
    lowerBody: lowerBodyPercentage,
    balanced,
    cardioScore: Math.round(cardioScore),
    strengthScore: Math.round(strengthScore),
  };
}

/**
 * Format muscle name for display
 */
export function formatMuscleName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
