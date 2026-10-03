import { describe, expect, it } from 'vitest';
import { REGIONS } from '../charts/muscleRegions.js';
import { buildSessionCandidates, recommendMuscleBalance, titleFocus } from '../services/muscleRecommendations.js';
import type { SessionCandidate } from '../services/muscleRecommendations.js';
import type { MuscleScores, MuscleSession } from '../types/muscleData.js';

const balanced: MuscleScores = Object.fromEntries(REGIONS.map(region => [region.sourceKeys[0], 10]));
const candidate = (key: string, scores: MuscleScores): SessionCandidate => ({
  key, scores, discipline: 'strength', focus: 'general', durationMinutes: 30,
  exampleTitles: ['30 min Strength'], sampleCount: 1,
});
const session = (rideId: string, title: string, durationSeconds = 1800, scores: MuscleScores = { core: 10 }): MuscleSession => ({
  rideId, title, durationSeconds, scores, discipline: 'strength',
});

describe('muscle balance planner', () => {
  it('returns no suggestions for balanced input, empty history or no period scores', () => {
    expect(recommendMuscleBalance(balanced, [candidate('a', { biceps: 10 })], 7).suggestions).toEqual([]);
    expect(recommendMuscleBalance({ core: 100 }, [], 7).suggestions).toEqual([]);
    expect(recommendMuscleBalance({}, [candidate('a', { biceps: 10 })], 7).suggestions).toEqual([]);
  });

  it('different deficits produce different plans and lift the shortfall region', () => {
    const candidates = [candidate('arms', { biceps: 10 }), candidate('glutes', { glutes: 10 })];
    const armsPlan = recommendMuscleBalance({ ...balanced, biceps: 0 }, candidates, 7);
    const glutesPlan = recommendMuscleBalance({ ...balanced, glutes: 0 }, candidates, 7);
    expect(armsPlan.suggestions.map(s => s.candidate.key)).toEqual(['arms']);
    expect(glutesPlan.suggestions.map(s => s.candidate.key)).toEqual(['glutes']);
    for (const [plan, region] of [[armsPlan, 'biceps'], [glutesPlan, 'glutes']] as const) {
      expect(plan.shortfallAfter).toBe(0);
      expect(plan.shortfallAfter).toBeLessThan(plan.shortfallBefore);
      expect(plan.suggestions[0]!.after[region]).toBeGreaterThan(plan.suggestions[0]!.before[region]);
      expect(plan.suggestions[0]!.lifts.some(lift => lift.region === region && lift.points > 0)).toBe(true);
    }
  });

  it.each([[1, 3], [14, 3], [15, 6], [90, 6]])('caps a %s-day window at %s sessions', (days, cap) => {
    const gradual = Object.fromEntries(REGIONS.filter(r => r.id !== 'core').map(r => [r.sourceKeys[0], 1]));
    const plan = recommendMuscleBalance({ core: 1000 }, [candidate('gradual', gradual)], days);
    expect(plan.suggestions).toHaveLength(cap);
    expect(plan.suggestions.every(s => s.shortfallImprovement >= 0.5)).toBe(true);
    expect(plan.shortfallAfter).toBeLessThan(plan.shortfallBefore);
  });

  it('breaks equal-score ties deterministically regardless of candidate order', () => {
    const candidates = [candidate('z', { biceps: 10 }), candidate('a', { biceps: 10 })];
    const scores = { ...balanced, biceps: 0 };
    const plan = recommendMuscleBalance(scores, candidates, 30);
    expect(plan).toEqual(recommendMuscleBalance(scores, [...candidates].reverse(), 30));
    expect(plan.suggestions[0]?.candidate.key).toBe('a');
  });

  it('rejects gains below 0.5 points, accepts exactly 0.5, then stops', () => {
    expect(recommendMuscleBalance({ core: 1000 }, [candidate('tiny', { biceps: 1 })], 30).suggestions).toEqual([]);
    const plan = recommendMuscleBalance({ core: 199 }, [candidate('threshold', { biceps: 1 })], 30);
    expect(plan.suggestions).toHaveLength(1);
    expect(plan.suggestions[0]!.shortfallImprovement).toBeCloseTo(0.5);
  });

  it('keeps Other in the denominator and does not mutate its inputs', () => {
    const scores = Object.freeze({ ...balanced, biceps: 0, other: 10 });
    const entries = Object.freeze([Object.freeze(candidate('arms', Object.freeze({ biceps: 10 }))) ]);
    const copy = JSON.stringify({ scores, entries });
    const plan = recommendMuscleBalance(scores, entries, 7);
    expect(plan.before.other).toBeCloseTo(100 * 10 / 130);
    expect(plan.after.other).toBeCloseTo(100 * 10 / 140);
    expect(JSON.stringify({ scores, entries })).toBe(copy);
  });
});

describe('candidate class types', () => {
  it.each([
    ['20 min Upper Body Strength', 'upper body'], ['20 min Legs Strength', 'lower body'],
    ['10 min Core Strength', 'core'], ['30 min Full Body Strength', 'full body'],
    ['20 min Arms & Shoulders Strength', 'arms/shoulders'], ['10 min Glutes Strength', 'glutes'],
    ['30 min Beyoncé Strength', 'general'],
  ])('uses the closed focus vocabulary for %s', (title, expected) => {
    expect(titleFocus(title, 'strength')).toBe(expected);
  });

  it('song, artist and theme titles do not create new class types', () => {
    const history = [session('a', '30 min EMINEM Ride'), session('b', '30 min Classic Rock Ride'), session('c', '30 min Back in Black Ride')]
      .map(s => ({ ...s, discipline: 'cycling' }));
    const candidates = buildSessionCandidates(history);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.key).toBe('cycling|16-30|general');
    expect(candidates[0]?.exampleTitles).toHaveLength(2);
    expect(candidates[0]?.exampleTitles.every(title => history.some(s => s.title === title))).toBe(true);
  });

  it('ignores body-part words inside themes rather than treating them as training focus', () => {
    const history = [session('a', '30 min Arms of an Angel Strength'), session('b', '30 min Core Memories Strength'), session('c', '30 min Beyoncé Strength')];
    expect(buildSessionCandidates(history)).toHaveLength(1);
    expect(buildSessionCandidates(history)[0]?.focus).toBe('general');
  });

  it('uses the user’s modal actual duration and averages distinct matching classes', () => {
    const a = session('a', '30 min Arms Strength', 1800, { biceps: 20 });
    const b = session('b', '30 min Arms & Shoulders Strength', 1800, { biceps: 40 });
    const history = [a, a, b, session('short', '20 min Arms Strength', 1200, { biceps: 1000 })];
    const candidates = buildSessionCandidates(history);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ durationMinutes: 30, sampleCount: 2, scores: { biceps: 30 } });
    expect(candidates[0]!.exampleTitles).toEqual(['30 min Arms & Shoulders Strength', '30 min Arms Strength']);
    expect(candidates).toEqual(buildSessionCandidates([...history].reverse()));
  });

  it('breaks duration-frequency ties by choosing the shorter actual duration', () => {
    const result = buildSessionCandidates([session('a', '20 min Strength', 1200), session('b', '30 min Strength', 1800)]);
    expect(result[0]?.durationMinutes).toBe(20);
    expect(result[0]?.exampleTitles).toEqual(['20 min Strength']);
  });

  it('uses matching units for raw versus per-minute candidate vectors', () => {
    const history = [session('a', '30 min Strength', 1800, { biceps: 90, core: 10 }), session('b', '30 min Strength', 1800, { biceps: 1, core: 9 })];
    expect(buildSessionCandidates(history, 'raw')[0]?.scores).toMatchObject({ biceps: 45.5, core: 9.5 });
    expect(buildSessionCandidates(history, 'per_minute')[0]?.scores).toMatchObject({ biceps: 15, core: 15 });
  });

  it('uses sparse history without inventing examples and ignores unusable sessions', () => {
    expect(buildSessionCandidates([])).toEqual([]);
    expect(buildSessionCandidates([session('empty', 'Empty', 1800, {})])).toEqual([]);
    expect(buildSessionCandidates([session('zero', 'Zero', 0)])).toEqual([]);
    expect(buildSessionCandidates([session('single', '10 min Core Strength', 600)])[0]).toMatchObject({ durationMinutes: 10, sampleCount: 1, exampleTitles: ['10 min Core Strength'] });
  });
});
