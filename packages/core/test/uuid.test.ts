import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUuidV7Generator, uuidv7 } from '../src';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function timestampOf(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

describe('uuidv7', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('produces lowercase RFC 9562 version 7 UUIDs', () => {
    for (let i = 0; i < 1000; i++) {
      expect(uuidv7()).toMatch(UUID_V7);
    }
  });

  it('encodes the Unix millisecond timestamp in the first 48 bits', () => {
    const now = 1_761_200_000_123;
    const generate = createUuidV7Generator({ now: () => now });
    expect(timestampOf(generate())).toBe(now);
  });

  it('handles the full 48-bit timestamp range', () => {
    expect(createUuidV7Generator({ now: () => 0 })()).toMatch(/^00000000-0000-7/);
    expect(createUuidV7Generator({ now: () => 2 ** 48 - 1 })()).toMatch(/^ffffffff-ffff-7/);
  });

  it.each([-1, 2 ** 48, NaN])('rejects timestamp %d', (now) => {
    expect(() => createUuidV7Generator({ now: () => now })()).toThrow(RangeError);
  });

  it('is strictly increasing for IDs created in the same millisecond', () => {
    const generate = createUuidV7Generator({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 10_000 }, generate);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => timestampOf(id) === 1_700_000_000_000)).toBe(true);
  });

  it('is strictly increasing across milliseconds', () => {
    let now = 1_700_000_000_000;
    const generate = createUuidV7Generator({ now: () => (now += 0.5) });
    const ids = Array.from({ length: 1000 }, generate);
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays increasing when the clock moves backwards', () => {
    const times = [5000, 5000, 4000, 3000, 5001];
    const generate = createUuidV7Generator({ now: () => times.shift() ?? 6000 });
    const ids = Array.from({ length: 6 }, generate);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.slice(0, 4).map(timestampOf)).toEqual([5000, 5000, 5000, 5000]);
    expect(timestampOf(ids[4]!)).toBe(5001);
  });

  it('carries the counter into rand_a when its low part overflows', () => {
    // Seed: rand_a counter 0x7ff, low counter at its maximum.
    const generate = createUuidV7Generator({
      now: () => 1000,
      random: (bytes) => {
        bytes.fill(0xff);
        bytes[0] = 0x07;
      },
    });
    const first = generate();
    const second = generate();
    expect(first.slice(14, 18)).toBe('77ff');
    expect(second.slice(14, 18)).toBe('7800');
    expect(timestampOf(second)).toBe(1000);
    expect(second > first).toBe(true);
  });

  it('moves to the next millisecond when the whole counter is exhausted', () => {
    // Seed: both counter parts at their maximum.
    const generate = createUuidV7Generator({
      now: () => 1000,
      random: (bytes) => bytes.fill(0xff),
    });
    const first = generate();
    const second = generate();
    expect(timestampOf(first)).toBe(1000);
    expect(timestampOf(second)).toBe(1001);
    expect(second > first).toBe(true);
  });

  it('is unique and ordered for the default generator', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('uses the injected random source', () => {
    const make = () =>
      createUuidV7Generator({ now: () => 1234, random: (bytes) => bytes.fill(0x42) });
    expect(make()()).toBe(make()());
  });

  it('explains how to recover when crypto.getRandomValues is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => createUuidV7Generator()()).toThrow(/generateId/);
  });
});
