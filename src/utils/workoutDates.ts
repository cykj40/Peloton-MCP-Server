import { APP_TIMEZONE } from '../constants.js';

export const WORKOUT_START_DATE_DESCRIPTION = `Start calendar date (YYYY-MM-DD, ${APP_TIMEZONE}) or an ISO timestamp with Z or a UTC offset.`;
export const WORKOUT_END_DATE_DESCRIPTION = `End calendar date (YYYY-MM-DD, ${APP_TIMEZONE}; whole day included) or an exact ISO timestamp with Z or a UTC offset.`;

/** Calendar ends are exclusive; explicit instant ends retain the existing inclusive contract. */
export interface WorkoutDateRange {
  startDate?: Date;
  endDate?: Date;
  endExclusive?: boolean;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i;
const FORMAT_ERROR = 'Date must be YYYY-MM-DD or an ISO timestamp with Z or a UTC offset';

function calendarUtc(year: number, month: number, day: number): Date {
  const date = new Date(0);
  // Unlike Date.UTC, setUTCFullYear does not reinterpret years 00–99 as 1900–1999.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** Shared schema/normalizer validation: never let Date silently roll February 31 into March. */
export function workoutDateInputError(value: string): string | undefined {
  const match = DATE_ONLY.exec(value) ?? TIMESTAMP.exec(value);
  if (!match) return FORMAT_ERROR;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = calendarUtc(year, month, day);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return `Invalid calendar date: ${value}`;
  }
  if (!DATE_ONLY.test(value) && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59 || !Number.isFinite(Date.parse(value)))) {
    return FORMAT_ERROR;
  }
  return undefined;
}

let formatter: Intl.DateTimeFormat | undefined;
function calendarFormatter(): Intl.DateTimeFormat {
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: APP_TIMEZONE, calendar: 'gregory', numberingSystem: 'latn',
        year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
      });
    } catch {
      throw new RangeError(`Invalid APP_TIMEZONE: ${APP_TIMEZONE}`);
    }
  }
  return formatter;
}

let displayFormatter: Intl.DateTimeFormat | undefined;

/** Human display only. Keep stored epoch seconds and machine-readable ISO fields unchanged. */
export function formatWorkoutDate(timestampSeconds: number, style: 'date' | 'dateTime' = 'dateTime'): string {
  const date = new Date(timestampSeconds * 1000);
  const calendar = calendarFormatter(); // Also validates APP_TIMEZONE with a clear configuration error.
  if (style === 'date') {
    const parts = Object.fromEntries(calendar.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts['year']!.padStart(4, '0')}-${parts['month']}-${parts['day']}`;
  }
  displayFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
  return displayFormatter.format(date);
}

/** Find the first instant of a local day, including repeated or skipped DST midnights. */
function localDayStart(calendar: Date, allowSkippedDay: boolean): Date {
  const target = calendar.getTime();
  const fmt = calendarFormatter();
  const dayAt = (instant: number): number => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const year = parts['era'] === 'BC' ? 1 - Number(parts['year']) : Number(parts['year']);
    return calendarUtc(year, Number(parts['month']), Number(parts['day'])).getTime();
  };
  // Every IANA UTC offset fits inside this bracket. Search calendar dates rather
  // than clock hours so an omitted 00:00 resolves to the first valid time that day.
  let before = target - 2 * 86400000, after = target + 2 * 86400000;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (dayAt(middle) < target) before = middle;
    else after = middle;
  }
  if (!allowSkippedDay && dayAt(after) !== target) {
    throw new RangeError(`Calendar date does not exist in APP_TIMEZONE: ${APP_TIMEZONE}`);
  }
  return new Date(after);
}

function normalizeBound(value: string, end: boolean): { date: Date; calendar: boolean } {
  const error = workoutDateInputError(value);
  if (error) throw new RangeError(error);
  const match = DATE_ONLY.exec(value);
  if (!match) return { date: new Date(value), calendar: false };
  const calendar = calendarUtc(Number(match[1]), Number(match[2]), Number(match[3]));
  const startOfDay = localDayStart(calendar, false);
  if (!end) return { date: startOfDay, calendar: true };
  // Advance the calendar first, then resolve its offset. Adding 24 hours to an instant breaks DST.
  calendar.setUTCDate(calendar.getUTCDate() + 1);
  return { date: localDayStart(calendar, true), calendar: true };
}

export function normalizeWorkoutDateRange(start?: string, end?: string): WorkoutDateRange {
  const range: WorkoutDateRange = {};
  if (start !== undefined) range.startDate = normalizeBound(start, false).date;
  if (end !== undefined) {
    const bound = normalizeBound(end, true);
    range.endDate = bound.date;
    range.endExclusive = bound.calendar;
  }
  if (range.startDate && range.endDate &&
      (range.startDate > range.endDate || (range.endExclusive && range.startDate.getTime() === range.endDate.getTime()))) {
    throw new RangeError('start_date must not be after end_date');
  }
  return range;
}

/** Compare epoch seconds against exact boundaries; retain fractional seconds in timed inputs. */
export function matchesWorkoutDateRange(timestampSeconds: number, range: WorkoutDateRange): boolean {
  if (range.startDate && !(timestampSeconds >= range.startDate.getTime() / 1000)) return false;
  if (range.endDate) {
    const end = range.endDate.getTime() / 1000;
    if (!(range.endExclusive ? timestampSeconds < end : timestampSeconds <= end)) return false;
  }
  return true;
}
