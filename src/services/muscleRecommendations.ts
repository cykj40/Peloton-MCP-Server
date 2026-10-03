import { REGIONS } from '../charts/muscleRegions.js';
import type { RegionId } from '../charts/muscleRegions.js';
import { PELOTON_MUSCLE_KEYS } from '../types/muscleData.js';
import type { MusclePercentages, MuscleScores, MuscleSession, MuscleWeighting } from '../types/muscleData.js';

export const PROJECTION_ASSUMPTION = "Projections assume each added session resembles your past classes of that type.";
export type FocusTag = 'upper body' | 'lower body' | 'core' | 'full body' | 'arms/shoulders' | 'glutes' | 'general';
export interface SessionCandidate {
  key: string;
  discipline: string;
  focus: FocusTag;
  durationMinutes: number;
  exampleTitles: string[];
  sampleCount: number;
  scores: MuscleScores;
}
export type RegionPercentages = Record<RegionId, number>;
export interface SessionSuggestion {
  candidate: SessionCandidate;
  before: RegionPercentages;
  after: RegionPercentages;
  lifts: Array<{ region: RegionId; before: number; after: number; points: number }>;
  shortfallImprovement: number;
}
export interface MusclePlan {
  suggestions: SessionSuggestion[];
  before: MusclePercentages;
  after: MusclePercentages;
  shortfallBefore: number;
  shortfallAfter: number;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Closed training vocabulary: music, artist and theme names never become type keys. */
export function titleFocus(title: string, discipline: string): FocusTag {
  if (!['strength', 'cardio', 'stretching', 'yoga'].includes(discipline.toLowerCase())) return 'general';
  const text = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Require a recognized training phrase, not a loose word occurring inside a song/theme.
  const format = '(?:strength|stretch|stretching|cardio|yoga|flow|barre|pilates|toning|workout|bootcamp)';
  const matches = (focus: string): boolean => new RegExp(`\\b(?:${focus})(?:\\s+${format}\\b|$)`).test(text);
  if (matches('upper body|chest (?:and )?back')) return 'upper body';
  if (matches('lower body|legs(?: (?:and )?glutes)?|glutes (?:and )?legs')) return 'lower body';
  if (matches('core|abs')) return 'core';
  if (matches('full body|total body') || /\btotal strength\b/.test(text)) return 'full body';
  if (matches('arms(?: (?:and )?shoulders)?|arms (?:and )?light weights|shoulders|biceps(?: (?:and )?triceps)?|triceps')) return 'arms/shoulders';
  if (matches('glutes')) return 'glutes';
  return 'general';
}

function durationBucket(minutes: number): string {
  return minutes <= 15 ? '0-15' : minutes <= 30 ? '16-30' : minutes <= 45 ? '31-45' : minutes <= 60 ? '46-60' : '61+';
}

function total(scores: MuscleScores): number {
  let sum = 0;
  for (const key of PELOTON_MUSCLE_KEYS) {
    const value = scores[key] ?? 0;
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid muscle scores');
    sum += value;
  }
  if (!Number.isFinite(sum)) throw new RangeError('Invalid muscle score total');
  return sum;
}

export function scorePercentages(scores: MuscleScores): MusclePercentages {
  const sum = total(scores);
  if (sum <= 0) return {};
  return Object.fromEntries(PELOTON_MUSCLE_KEYS.map(key => [key, 100 * (scores[key] ?? 0) / sum]));
}

export function regionPercentages(percentages: MusclePercentages): RegionPercentages {
  return Object.fromEntries(REGIONS.map(region => [region.id,
    region.sourceKeys.reduce((sum, key) => sum + (percentages[key] ?? 0), 0),
  ])) as RegionPercentages;
}

function shortfall(regions: RegionPercentages): number {
  return Object.values(regions).reduce((sum, value) => sum + Math.max(0, 5 - value), 0);
}

/** Caller supplies only this user's last 90 days. Repeated rides affect modal duration, not vector averaging. */
export function buildSessionCandidates(history: readonly MuscleSession[], weighting: MuscleWeighting = 'raw'): SessionCandidate[] {
  if (weighting !== 'raw' && weighting !== 'per_minute') throw new RangeError('Invalid weighting');
  const groups = new Map<string, { discipline: string; focus: FocusTag; sessions: MuscleSession[] }>();
  // Stable order also makes deduplication and floating point sums independent of input ordering.
  const ordered = [...history].sort((a, b) => compare(a.rideId, b.rideId) || compare(a.title, b.title));
  for (const session of ordered) {
    if (!Number.isFinite(session.durationSeconds) || session.durationSeconds <= 0 || total(session.scores) <= 0) continue;
    const discipline = session.discipline.toLowerCase();
    const focus = titleFocus(session.title, discipline);
    const key = `${discipline}|${durationBucket(session.durationSeconds / 60)}|${focus}`;
    const group = groups.get(key) ?? { discipline, focus, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => compare(a, b)).map(([key, group]) => {
    const frequencies = new Map<number, number>();
    for (const session of group.sessions) frequencies.set(session.durationSeconds, (frequencies.get(session.durationSeconds) ?? 0) + 1);
    const durationSeconds = [...frequencies.entries()].sort(([a, ca], [b, cb]) => cb - ca || a - b)[0]![0];
    // Use actual classes of the suggested duration, so both vectors and example titles match the suggestion.
    const sessions = [...new Map(group.sessions.filter(s => s.durationSeconds === durationSeconds).map(s => [s.rideId, s])).values()];
    const scores: MuscleScores = {};
    for (const session of sessions) {
      const scale = weighting === 'per_minute' ? durationSeconds / 60 / total(session.scores) : 1;
      for (const muscle of PELOTON_MUSCLE_KEYS) scores[muscle] = (scores[muscle] ?? 0) + (session.scores[muscle] ?? 0) * scale / sessions.length;
    }
    return { key, discipline: group.discipline, focus: group.focus, durationMinutes: durationSeconds / 60,
      exampleTitles: [...new Set(sessions.map(s => s.title))].sort(compare).slice(0, 2), sampleCount: sessions.length, scores };
  });
}

/** Pure greedy planner; all scores must use the same weighting units. Other stays in the denominator. */
export function recommendMuscleBalance(scores: MuscleScores, candidates: readonly SessionCandidate[], days: number): MusclePlan {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new RangeError('Invalid days');
  const before = scorePercentages(scores);
  let current = { ...scores };
  let percentages = before;
  let regions = regionPercentages(percentages);
  let deficit = shortfall(regions);
  const plan: MusclePlan = { suggestions: [], before, after: before, shortfallBefore: deficit, shortfallAfter: deficit };
  if (total(scores) <= 0 || deficit <= 1e-9) return plan;
  const usable = [...candidates].filter(candidate => total(candidate.scores) > 0).sort((a, b) => compare(a.key, b.key));
  for (let step = 0; step < (days <= 14 ? 3 : 6); step++) {
    let best: { candidate: SessionCandidate; scores: MuscleScores; percentages: MusclePercentages; regions: RegionPercentages; deficit: number; gain: number; minimum: number } | undefined;
    for (const candidate of usable) {
      const next: MuscleScores = {};
      for (const key of PELOTON_MUSCLE_KEYS) next[key] = (current[key] ?? 0) + (candidate.scores[key] ?? 0);
      const nextPercentages = scorePercentages(next);
      const nextRegions = regionPercentages(nextPercentages);
      const nextDeficit = shortfall(nextRegions);
      const gain = deficit - nextDeficit;
      const minimum = Math.min(...Object.values(nextRegions));
      if (!best || gain > best.gain + 1e-9 || (Math.abs(gain - best.gain) <= 1e-9 && minimum > best.minimum + 1e-9)) {
        best = { candidate, scores: next, percentages: nextPercentages, regions: nextRegions, deficit: nextDeficit, gain, minimum };
      }
    }
    if (!best || best.gain < 0.5 - 1e-9) break;
    const lifts = REGIONS.flatMap(region => {
      const points = best.regions[region.id] - regions[region.id];
      return points > 1e-9 ? [{ region: region.id, before: regions[region.id], after: best.regions[region.id], points }] : [];
    });
    plan.suggestions.push({ candidate: best.candidate, before: regions, after: best.regions, lifts, shortfallImprovement: best.gain });
    current = best.scores; percentages = best.percentages; regions = best.regions; deficit = best.deficit;
    if (deficit <= 1e-9) break;
  }
  plan.after = percentages;
  plan.shortfallAfter = deficit;
  return plan;
}
