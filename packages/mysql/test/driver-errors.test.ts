import { describe, expect, it } from 'vitest';
import { errorMessage, errorNumber } from '../src/driver-errors';

describe('driver errors', () => {
  it('reads the errno and message of driver errors', () => {
    const error = Object.assign(new Error("Duplicate entry 'x'"), { errno: 1062 });
    expect(errorNumber(error)).toBe(1062);
    expect(errorMessage(error)).toBe("Duplicate entry 'x'");
  });

  it.each([null, undefined, 'boom', 42])('ignores thrown non-errors (%j)', (thrown) => {
    expect(errorNumber(thrown)).toBeUndefined();
    expect(errorMessage(thrown)).toBe('');
  });
});
