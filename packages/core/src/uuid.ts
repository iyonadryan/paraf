/** Options for {@link createUuidV7Generator}. Mainly useful for tests. */
export interface UuidV7GeneratorOptions {
  /** Current time in Unix milliseconds. Default `Date.now`. */
  now?: () => number;
  /** Fills `bytes` with random values. Default `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array) => void;
}

/** A function returning a new UUID string on each call. */
export type IdGenerator = () => string;

const MAX_TIMESTAMP = 2 ** 48 - 1;
const COUNTER_LOW_MAX = 0x3fffffff; // 30 bits
const COUNTER_HIGH_MAX = 0xfff; // 12 bits

function defaultRandom(bytes: Uint8Array): void {
  const webCrypto = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new Error(
      'Paraf: crypto.getRandomValues is not available; pass a custom `generateId` to createEngine().',
    );
  }
  webCrypto.getRandomValues(bytes);
}

/**
 * Creates a UUID v7 generator (RFC 9562).
 *
 * Layout: 48-bit Unix millisecond timestamp, version, a 42-bit counter (12 bits of `rand_a`
 * plus the top 30 bits of `rand_b`), variant, and 32 random bits. The counter starts at a
 * random value every millisecond and is incremented for IDs created within the same
 * millisecond, so IDs from one generator are strictly increasing, also when the clock moves
 * backwards (the last timestamp is reused until the clock catches up). If the counter runs out
 * within one millisecond, the generator moves on to the next millisecond.
 */
export function createUuidV7Generator(options: UuidV7GeneratorOptions = {}): IdGenerator {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  const seed = new Uint8Array(6);
  const seedView = new DataView(seed.buffer);

  let lastTimestamp = -1;
  let counterHigh = 0;
  let counterLow = 0;

  const reseed = (): void => {
    random(seed);
    counterHigh = seedView.getUint16(0) & COUNTER_HIGH_MAX;
    counterLow = seedView.getUint32(2) >>> 2;
  };

  return () => {
    const current = Math.floor(now());
    if (!Number.isFinite(current) || current < 0 || current > MAX_TIMESTAMP) {
      throw new RangeError(`Paraf: timestamp ${current} is out of range for UUID v7.`);
    }

    if (current > lastTimestamp) {
      lastTimestamp = current;
      reseed();
    } else {
      counterLow++;
      if (counterLow > COUNTER_LOW_MAX) {
        counterLow = 0;
        counterHigh++;
        if (counterHigh > COUNTER_HIGH_MAX) {
          // Counter exhausted within one millisecond: borrow the next millisecond.
          lastTimestamp++;
          reseed();
        }
      }
    }

    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, Math.floor(lastTimestamp / 2 ** 16));
    view.setUint16(4, lastTimestamp % 2 ** 16);
    view.setUint16(6, 0x7000 | counterHigh); // version 7 + counter high bits (rand_a)
    view.setUint32(8, 0x80000000 + counterLow); // variant 0b10 + counter low bits
    random(bytes.subarray(12));

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/**
 * Returns a new UUID v7 string such as `"0192f0c4-7a1e-7b3c-9d2e-4f5a6b7c8d9e"`.
 * IDs created by this function are strictly increasing within the process.
 */
export const uuidv7: IdGenerator = createUuidV7Generator();
