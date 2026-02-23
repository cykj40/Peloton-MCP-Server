import {
  PelotonWorkout,
  GlucoseReading,
  GlucoseCorrelation,
  DisciplineInsight,
  HypoglycemiaAlert,
} from '../types/index.js';
import {
  insertGlucoseCorrelation,
  getAllCorrelations,
} from '../db/queries.js';

/**
 * Convert ISO 8601 timestamp to Unix timestamp (seconds)
 */
function isoToUnix(isoString: string): number {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Find the glucose reading closest to a target timestamp
 */
function findClosestReading(
  readings: GlucoseReading[],
  targetTimestamp: number,
  maxDeltaSeconds: number = 900 // 15 minutes default
): GlucoseReading | null {
  let closest: GlucoseReading | null = null;
  let minDelta = Infinity;

  for (const reading of readings) {
    const readingTimestamp = isoToUnix(reading.recordedAt);
    const delta = Math.abs(readingTimestamp - targetTimestamp);

    if (delta < minDelta && delta <= maxDeltaSeconds) {
      minDelta = delta;
      closest = reading;
    }
  }

  return closest;
}

/**
 * Calculate average glucose in a time window
 */
function averageGlucoseInWindow(
  readings: GlucoseReading[],
  startTimestamp: number,
  endTimestamp: number
): number | null {
  const relevantReadings = readings.filter((r) => {
    const ts = isoToUnix(r.recordedAt);
    return ts >= startTimestamp && ts <= endTimestamp;
  });

  if (relevantReadings.length === 0) {
    return null;
  }

  const sum = relevantReadings.reduce((acc, r) => acc + r.value, 0);
  return Math.round(sum / relevantReadings.length);
}

/**
 * Find the glucose nadir (lowest point) in a time window
 */
function findNadir(
  readings: GlucoseReading[],
  startTimestamp: number,
  endTimestamp: number
): { value: number; timestamp: number } | null {
  let nadir: { value: number; timestamp: number } | null = null;

  for (const reading of readings) {
    const ts = isoToUnix(reading.recordedAt);

    if (ts >= startTimestamp && ts <= endTimestamp) {
      if (!nadir || reading.value < nadir.value) {
        nadir = { value: reading.value, timestamp: ts };
      }
    }
  }

  return nadir;
}

/**
 * Find recovery time: when glucose returns to within 10 mg/dL of pre-workout level
 */
function findRecoveryTime(
  readings: GlucoseReading[],
  nadirTimestamp: number,
  preWorkoutGlucose: number,
  maxSearchSeconds: number = 14400 // 4 hours
): number | null {
  const targetRange = 10; // mg/dL
  const endTimestamp = nadirTimestamp + maxSearchSeconds;

  for (const reading of readings) {
    const ts = isoToUnix(reading.recordedAt);

    if (ts > nadirTimestamp && ts <= endTimestamp) {
      if (Math.abs(reading.value - preWorkoutGlucose) <= targetRange) {
        // Calculate recovery time in minutes
        return Math.round((ts - nadirTimestamp) / 60);
      }
    }
  }

  return null;
}

/**
 * Analyze how a workout affected blood glucose levels
 */
export function analyzeWorkoutGlucoseImpact(
  workout: PelotonWorkout,
  glucoseReadings: GlucoseReading[]
): GlucoseCorrelation {
  const workoutStart = workout.created_at;
  const workoutEnd = workoutStart + workout.duration;

  // Calculate pre-workout glucose (30 minutes before start)
  const preWorkoutGlucose = averageGlucoseInWindow(
    glucoseReadings,
    workoutStart - 1800, // 30 min before
    workoutStart
  );

  // Find glucose at start (closest reading within 15 min)
  const glucoseAtStartReading = findClosestReading(glucoseReadings, workoutStart, 900);
  const glucoseAtStart = glucoseAtStartReading?.value || null;

  // Find nadir in the 4 hours post-workout
  const nadir = findNadir(glucoseReadings, workoutEnd, workoutEnd + 14400);

  const glucoseNadir = nadir?.value || null;
  const glucoseNadirTime = nadir ? Math.round((nadir.timestamp - workoutStart) / 60) : null;

  // Find glucose 4 hours post-workout
  const glucose4hPostReading = findClosestReading(glucoseReadings, workoutEnd + 14400, 900);
  const glucose4hPost = glucose4hPostReading?.value || null;

  // Calculate average drop
  const avgDrop =
    glucoseAtStart !== null && glucoseNadir !== null ? glucoseAtStart - glucoseNadir : null;

  // Calculate recovery time
  const recoveryTimeMinutes =
    nadir && preWorkoutGlucose
      ? findRecoveryTime(glucoseReadings, nadir.timestamp, preWorkoutGlucose)
      : null;

  // Generate notes
  let notes = '';
  if (glucoseNadir && glucoseNadir < 70) {
    notes = 'Hypoglycemia detected (glucose < 70 mg/dL). ';
  }
  if (glucoseNadirTime && glucoseNadirTime > 120) {
    notes += 'Delayed glucose drop (> 2 hours post-workout). ';
  }

  const correlation: GlucoseCorrelation = {
    workout_id: workout.id,
    workout_timestamp: workoutStart,
    discipline: workout.fitness_discipline,
    duration_seconds: workout.duration,
    pre_workout_glucose: preWorkoutGlucose,
    glucose_at_start: glucoseAtStart,
    glucose_nadir: glucoseNadir,
    glucose_nadir_time: glucoseNadirTime,
    glucose_4h_post: glucose4hPost,
    avg_drop: avgDrop,
    recovery_time_minutes: recoveryTimeMinutes,
    notes: notes.trim() || null,
  };

  // Save to database
  const correlationId = insertGlucoseCorrelation(correlation);
  correlation.id = correlationId;

  return correlation;
}

/**
 * Get aggregated insights by discipline
 */
export function getInsightsByDiscipline(): DisciplineInsight[] {
  const allCorrelations = getAllCorrelations();

  // Group by discipline
  const byDiscipline: { [key: string]: GlucoseCorrelation[] } = {};

  for (const corr of allCorrelations) {
    if (!byDiscipline[corr.discipline]) {
      byDiscipline[corr.discipline] = [];
    }
    byDiscipline[corr.discipline].push(corr);
  }

  // Calculate insights for each discipline
  const insights: DisciplineInsight[] = [];

  for (const [discipline, correlations] of Object.entries(byDiscipline)) {
    const validDrops = correlations.filter((c) => c.avg_drop !== null).map((c) => c.avg_drop!);
    const validNadirTimes = correlations
      .filter((c) => c.glucose_nadir_time !== null)
      .map((c) => c.glucose_nadir_time!);
    const validRecoveryTimes = correlations
      .filter((c) => c.recovery_time_minutes !== null)
      .map((c) => c.recovery_time_minutes!);
    const validPreWorkout = correlations
      .filter((c) => c.pre_workout_glucose !== null)
      .map((c) => c.pre_workout_glucose!);
    const validNadir = correlations
      .filter((c) => c.glucose_nadir !== null)
      .map((c) => c.glucose_nadir!);

    if (validDrops.length === 0) continue;

    const avgDrop = Math.round(validDrops.reduce((a, b) => a + b, 0) / validDrops.length);
    const avgNadirTime =
      validNadirTimes.length > 0
        ? Math.round(validNadirTimes.reduce((a, b) => a + b, 0) / validNadirTimes.length)
        : 0;
    const avgRecoveryTime =
      validRecoveryTimes.length > 0
        ? Math.round(validRecoveryTimes.reduce((a, b) => a + b, 0) / validRecoveryTimes.length)
        : 0;
    const avgPreWorkout =
      validPreWorkout.length > 0
        ? Math.round(validPreWorkout.reduce((a, b) => a + b, 0) / validPreWorkout.length)
        : 0;
    const avgNadir =
      validNadir.length > 0
        ? Math.round(validNadir.reduce((a, b) => a + b, 0) / validNadir.length)
        : 0;

    // Determine risk level
    let riskLevel: 'low' | 'moderate' | 'high';
    if (avgDrop >= 50) {
      riskLevel = 'high';
    } else if (avgDrop >= 30) {
      riskLevel = 'moderate';
    } else {
      riskLevel = 'low';
    }

    insights.push({
      discipline,
      avg_drop: avgDrop,
      avg_nadir_time: avgNadirTime,
      avg_recovery_time: avgRecoveryTime,
      sample_count: correlations.length,
      risk_level: riskLevel,
      avg_pre_workout: avgPreWorkout,
      avg_nadir: avgNadir,
    });
  }

  // Sort by average drop (highest impact first)
  insights.sort((a, b) => b.avg_drop - a.avg_drop);

  return insights;
}

/**
 * Detect delayed hypoglycemia patterns
 */
export function detectDelayedHypoglycemia(
  correlations?: GlucoseCorrelation[]
): HypoglycemiaAlert[] {
  const corrs = correlations || getAllCorrelations();
  const alerts: HypoglycemiaAlert[] = [];

  for (const corr of corrs) {
    if (corr.glucose_nadir === null || corr.glucose_nadir_time === null) {
      continue;
    }

    const isHypoglycemic = corr.glucose_nadir < 80;
    const isDelayed = corr.glucose_nadir_time > 120; // > 2 hours post-workout

    if (isHypoglycemic || isDelayed) {
      let severity: 'mild' | 'moderate' | 'severe';
      if (corr.glucose_nadir < 54) {
        severity = 'severe';
      } else if (corr.glucose_nadir < 70) {
        severity = 'moderate';
      } else {
        severity = 'mild';
      }

      let notes = '';
      if (isDelayed) {
        notes += `Delayed glucose drop (nadir at ${Math.round(corr.glucose_nadir_time / 60)}h post-workout). `;
      }
      if (isHypoglycemic) {
        notes += `Glucose dropped to ${corr.glucose_nadir} mg/dL. `;
      }

      alerts.push({
        workout_id: corr.workout_id,
        discipline: corr.discipline,
        workout_timestamp: corr.workout_timestamp,
        glucose_nadir: corr.glucose_nadir,
        nadir_time_minutes: corr.glucose_nadir_time,
        severity,
        is_delayed: isDelayed,
        notes: notes.trim(),
      });
    }
  }

  // Sort by severity and timestamp
  alerts.sort((a, b) => {
    const severityOrder = { severe: 3, moderate: 2, mild: 1 };
    const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.workout_timestamp - a.workout_timestamp;
  });

  return alerts;
}
