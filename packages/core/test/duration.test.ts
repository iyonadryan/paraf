import { describe, expect, it } from 'vitest';
import { addDuration, parseDuration } from '../src/duration';

const zero = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };

describe('parseDuration', () => {
  it.each([
    ['P3D', { days: 3 }],
    ['PT12H', { hours: 12 }],
    ['PT30M', { minutes: 30 }],
    ['P2W', { weeks: 2 }],
    ['P1M', { months: 1 }],
    ['P0D', {}],
    [
      'P1Y2M3W4DT5H6M7S',
      { years: 1, months: 2, weeks: 3, days: 4, hours: 5, minutes: 6, seconds: 7 },
    ],
  ])('parses %s', (text, parts) => {
    expect(parseDuration(text)).toEqual({ ...zero, ...parts });
  });

  it.each(['', 'P', 'PT', 'P1DT', '3D', 'p3d', 'P1.5D', 'P-1D', 'PT1D', 'P1H', ' P1D'])(
    'rejects %j',
    (text) => {
      expect(parseDuration(text)).toBeNull();
    },
  );
});

describe('addDuration', () => {
  const add = (start: string, duration: string) =>
    addDuration(new Date(start), parseDuration(duration)!).toISOString();

  it.each([
    ['2026-01-05T08:00:00.000Z', 'PT12H', '2026-01-05T20:00:00.000Z'],
    ['2026-01-05T08:00:00.000Z', 'P3D', '2026-01-08T08:00:00.000Z'],
    ['2026-01-05T08:00:00.000Z', 'P2W', '2026-01-19T08:00:00.000Z'],
    ['2026-01-05T08:00:00.000Z', 'PT90M30S', '2026-01-05T09:30:30.000Z'],
    ['2026-12-30T23:00:00.000Z', 'P2DT2H', '2027-01-02T01:00:00.000Z'],
    ['2026-11-15T00:00:00.000Z', 'P3M', '2027-02-15T00:00:00.000Z'],
    ['2026-01-31T10:00:00.000Z', 'P1M', '2026-02-28T10:00:00.000Z'],
    ['2028-01-31T10:00:00.000Z', 'P1M', '2028-02-29T10:00:00.000Z'],
    ['2028-02-29T10:00:00.000Z', 'P1Y', '2029-02-28T10:00:00.000Z'],
    ['2026-01-31T00:00:00.000Z', 'P1M1D', '2026-03-01T00:00:00.000Z'],
    ['2026-01-05T08:00:00.000Z', 'P1Y2M3DT4H5M6S', '2027-03-08T12:05:06.000Z'],
  ])('%s + %s = %s', (start, duration, expected) => {
    expect(add(start, duration)).toBe(expected);
  });

  it('does not change the input date', () => {
    const start = new Date('2026-01-05T08:00:00.000Z');
    addDuration(start, parseDuration('P1D')!);
    expect(start.toISOString()).toBe('2026-01-05T08:00:00.000Z');
  });
});
