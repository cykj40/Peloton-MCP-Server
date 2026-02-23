import {
  GlucoseCorrelationAnalysisSchema,
  MuscleAnalysisSchema,
  SyncWorkoutsSchema,
  WorkoutSearchSchema,
  WorkoutStatsSchema,
} from '../schemas/index.js';

describe('schemas', () => {
  describe('WorkoutSearchSchema', () => {
    it('applies defaults and accepts optional fields', () => {
      const parsed = WorkoutSearchSchema.parse({});
      expect(parsed.limit).toBe(10);
      expect(parsed.response_format).toBe('markdown');

      const full = WorkoutSearchSchema.parse({
        limit: 20,
        discipline: 'cycling',
        instructor: 'Alex',
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        response_format: 'json',
      });
      expect(full.response_format).toBe('json');
    });

    it('rejects invalid limits and response format', () => {
      expect(() => WorkoutSearchSchema.parse({ limit: 0 })).toThrow();
      expect(() => WorkoutSearchSchema.parse({ limit: 101 })).toThrow();
      expect(() => WorkoutSearchSchema.parse({ response_format: 'xml' })).toThrow();
    });
  });

  describe('MuscleAnalysisSchema', () => {
    it('accepts valid periods and defaults to 7_days', () => {
      expect(MuscleAnalysisSchema.parse({}).period).toBe('7_days');
      expect(MuscleAnalysisSchema.parse({ period: '30_days' }).period).toBe('30_days');
      expect(MuscleAnalysisSchema.parse({ period: '90_days' }).period).toBe('90_days');
    });

    it('rejects invalid period', () => {
      expect(() => MuscleAnalysisSchema.parse({ period: '365_days' })).toThrow();
    });
  });

  describe('WorkoutStatsSchema', () => {
    it('accepts valid date strings', () => {
      const parsed = WorkoutStatsSchema.parse({ start_date: '2025-01-01', end_date: '2025-01-31' });
      expect(parsed.start_date).toBe('2025-01-01');
    });

    it('rejects invalid date format', () => {
      expect(() => WorkoutStatsSchema.parse({ start_date: '01/01/2025' })).toThrow();
    });
  });

  describe('GlucoseCorrelationAnalysisSchema', () => {
    it('accepts recordedAt and recorded_at variants', () => {
      const withRecordedAt = GlucoseCorrelationAnalysisSchema.parse({
        workout_id: 'w1',
        glucose_readings: [{ value: 100, recordedAt: '2025-01-01T00:00:00Z' }],
      });
      const withRecordedAtAlt = GlucoseCorrelationAnalysisSchema.parse({
        workout_id: 'w1',
        glucose_readings: [{ value: 100, recorded_at: '2025-01-01T00:00:00Z' }],
      });
      expect(withRecordedAt.glucose_readings).toHaveLength(1);
      expect(withRecordedAtAlt.glucose_readings).toHaveLength(1);
    });

    it('fails when both timestamp fields are missing', () => {
      expect(() =>
        GlucoseCorrelationAnalysisSchema.parse({
          workout_id: 'w1',
          glucose_readings: [{ value: 100 }],
        })
      ).toThrow();
    });
  });

  describe('SyncWorkoutsSchema', () => {
    it('accepts boundaries and rejects out-of-range', () => {
      expect(SyncWorkoutsSchema.parse({ limit: 1 }).limit).toBe(1);
      expect(SyncWorkoutsSchema.parse({ limit: 100 }).limit).toBe(100);
      expect(() => SyncWorkoutsSchema.parse({ limit: 0 })).toThrow();
      expect(() => SyncWorkoutsSchema.parse({ limit: 101 })).toThrow();
    });
  });
});
