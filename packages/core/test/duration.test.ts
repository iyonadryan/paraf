import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/duration';

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
