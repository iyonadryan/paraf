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
