import { describe, expect, it } from 'vitest';
import { errorField } from '../src/driver-errors';

describe('errorField', () => {
  it('reads fields of driver errors', () => {
    const error = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq' });
    expect(errorField(error, 'code')).toBe('23505');
    expect(errorField(error, 'constraint')).toBe('uq');
    expect(errorField(new Error('plain'), 'code')).toBeUndefined();
  });

  it.each([null, undefined, 'boom', 42])('ignores thrown non-objects (%j)', (thrown) => {
    expect(errorField(thrown, 'code')).toBeUndefined();
  });
});
