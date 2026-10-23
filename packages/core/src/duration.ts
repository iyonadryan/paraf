/** Components of an ISO 8601 duration such as `P1DT12H`. */
export interface Duration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Integer-only ISO 8601 durations: `PnYnMnWnDTnHnMnS`, at least one component, and `T` only
 * when followed by a time component.
 */
export const DURATION_PATTERN =
  '^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+S)?)?$';

const DURATION_REGEX =
  /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Adds a duration to a date in UTC. Years and months are calendar months (the day is clamped to
 * the end of a shorter month, so Jan 31 + P1M is Feb 28/29); weeks and days are calendar days;
 * hours, minutes, and seconds are exact.
 */
export function addDuration(date: Date, duration: Duration): Date {
  const result = new Date(date.getTime());
  const months = result.getUTCMonth() + duration.months + duration.years * 12;
  const year = result.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  result.setUTCFullYear(year, month, Math.min(result.getUTCDate(), daysInMonth(year, month)));
  result.setUTCDate(result.getUTCDate() + duration.weeks * 7 + duration.days);
  const seconds = (duration.hours * 60 + duration.minutes) * 60 + duration.seconds;
  return new Date(result.getTime() + seconds * 1000);
}

/** Parses an ISO 8601 duration, returning `null` when the text is not a valid duration. */
export function parseDuration(text: string): Duration | null {
  const match = DURATION_REGEX.exec(text);
  if (!match) return null;
  const part = (index: number): number => Number(match[index] ?? 0);
  return {
    years: part(1),
    months: part(2),
    weeks: part(3),
    days: part(4),
    hours: part(5),
    minutes: part(6),
    seconds: part(7),
  };
}
