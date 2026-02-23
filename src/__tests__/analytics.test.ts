import {
  analyzeTrainingBalance,
  calculateMuscleActivity,
  calculateMuscleImpact,
  calculateWorkoutStats,
  formatMuscleName,
  getMuscleIntensity,
} from '../services/analytics.js';
import { makeMockWorkout } from './fixtures.js';

describe('analytics service', () => {
  describe('getMuscleIntensity', () => {
    it('returns base mappings for all non-strength disciplines', () => {
      expect(getMuscleIntensity('cycling')).toMatchObject({
        quadriceps: 9,
        hamstrings: 7,
        calves: 8,
      });
      expect(getMuscleIntensity('running')).toMatchObject({ calves: 10 });
      expect(getMuscleIntensity('walking')).toMatchObject({ core: 4 });
      expect(getMuscleIntensity('yoga')).toMatchObject({ lower_back: 6 });
      expect(getMuscleIntensity('meditation')).toEqual({});
      expect(getMuscleIntensity('cardio')).toMatchObject({ quadriceps: 7 });
      expect(getMuscleIntensity('stretching')).toMatchObject({ back: 6 });
    });

    it('handles strength keywords and generic title', () => {
      expect(getMuscleIntensity('strength', 'Upper Body Blast')).toMatchObject({
        chest: 8,
        triceps: 9,
      });
      expect(getMuscleIntensity('strength', 'Lower Body Burn')).toMatchObject({
        quadriceps: 9,
        glutes: 8,
      });
      expect(getMuscleIntensity('strength', 'Core Crusher')).toMatchObject({
        core: 10,
        obliques: 8,
      });
      expect(getMuscleIntensity('strength', 'Strength')).toMatchObject({
        chest: 6,
        quadriceps: 6,
      });
    });
  });

  describe('calculateMuscleImpact', () => {
    it('accumulates scores and caps duration factor at 1 for >= 30 minutes', () => {
      const longRide = makeMockWorkout({ id: 'w1', duration: 1800, fitness_discipline: 'cycling' });
      const shortRide = makeMockWorkout({ id: 'w2', duration: 600, fitness_discipline: 'cycling' });

      const impact = calculateMuscleImpact([longRide, shortRide]);

      expect(impact.quadriceps?.score).toBeCloseTo(12, 3);
      expect(impact.quadriceps?.workouts).toBe(2);
      expect(impact).toEqual(
        expect.objectContaining({
          quadriceps: expect.objectContaining({ score: expect.any(Number), workouts: expect.any(Number) }),
        })
      );
    });

    it('falls back for unknown discipline', () => {
      const unknown = makeMockWorkout({ fitness_discipline: 'unknown' });
      const impact = calculateMuscleImpact([unknown]);
      expect(impact.full_body?.score).toBeGreaterThan(0);
      expect(impact.full_body?.workouts).toBe(1);
    });
  });

  describe('calculateMuscleActivity', () => {
    const now = Math.floor(Date.now() / 1000);

    it('filters by period, excludes non-visual muscles, and sums to ~100', () => {
      const workouts = [
        makeMockWorkout({ id: 'a', created_at: now - 2 * 24 * 3600, fitness_discipline: 'cycling' }),
        makeMockWorkout({ id: 'b', created_at: now - 20 * 24 * 3600, fitness_discipline: 'running' }),
        makeMockWorkout({ id: 'c', created_at: now - 80 * 24 * 3600, fitness_discipline: 'unknown' }),
      ];

      const sevenDays = calculateMuscleActivity(workouts, '7_days');
      const thirtyDays = calculateMuscleActivity(workouts, '30_days');
      const ninetyDays = calculateMuscleActivity(workouts, '90_days');

      expect(Object.keys(sevenDays)).not.toContain('Full Body');
      expect(Object.keys(thirtyDays).length).toBeGreaterThanOrEqual(Object.keys(sevenDays).length);
      expect(Object.keys(ninetyDays).length).toBeGreaterThanOrEqual(Object.keys(thirtyDays).length);

      const sum = Object.values(thirtyDays).reduce((acc, value) => acc + value, 0);
      expect(sum).toBeGreaterThanOrEqual(95);
      expect(sum).toBeLessThanOrEqual(105);
    });

    it('returns empty object for empty input', () => {
      expect(calculateMuscleActivity([], '7_days')).toEqual({});
    });
  });

  describe('calculateWorkoutStats', () => {
    it('calculates totals, averages, discipline grouping, and date filters', () => {
      const now = Math.floor(Date.now() / 1000);
      const workouts = [
        makeMockWorkout({ id: '1', duration: 1000, calories: 100, created_at: now - 86400, fitness_discipline: 'cycling' }),
        makeMockWorkout({ id: '2', duration: 2000, calories: 200, created_at: now - 43200, fitness_discipline: 'running' }),
        makeMockWorkout({ id: '3', duration: 3000, calories: 300, created_at: now - 1000, fitness_discipline: 'cycling' }),
      ];

      const start = new Date((now - 50000) * 1000);
      const end = new Date((now - 500) * 1000);
      const stats = calculateWorkoutStats(workouts, start, end);

      expect(stats.total_workouts).toBe(2);
      expect(stats.total_duration).toBe(5000);
      expect(stats.avg_duration).toBe(2500);
      expect(stats.disciplines).toEqual({ running: 1, cycling: 1 });
      expect(new Date(stats.period_start).getTime()).toBeLessThanOrEqual(new Date(stats.period_end).getTime());
    });
  });

  describe('analyzeTrainingBalance', () => {
    it('detects balanced and imbalanced distributions', () => {
      const balanced = analyzeTrainingBalance({
        chest: { score: 50, workouts: 1 },
        quadriceps: { score: 50, workouts: 1 },
      });
      expect(balanced.upperBody).toBe(50);
      expect(balanced.lowerBody).toBe(50);
      expect(balanced.balanced).toBe(true);

      const upperHeavy = analyzeTrainingBalance({
        chest: { score: 80, workouts: 1 },
        quadriceps: { score: 20, workouts: 1 },
      });
      expect(upperHeavy.upperBody).toBe(80);
      expect(upperHeavy.lowerBody).toBe(20);
      expect(upperHeavy.balanced).toBe(false);

      const lowerHeavy = analyzeTrainingBalance({
        chest: { score: 20, workouts: 1 },
        quadriceps: { score: 80, workouts: 1 },
      });
      expect(lowerHeavy.upperBody).toBe(20);
      expect(lowerHeavy.lowerBody).toBe(80);
      expect(lowerHeavy.balanced).toBe(false);
    });
  });

  describe('formatMuscleName', () => {
    it('formats muscle names', () => {
      expect(formatMuscleName('lower_back')).toBe('Lower Back');
      expect(formatMuscleName('quadriceps')).toBe('Quadriceps');
    });
  });
});
