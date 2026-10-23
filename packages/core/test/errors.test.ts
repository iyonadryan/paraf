import { describe, expect, it } from 'vitest';
import { FlowValidationError, ParafError, validateFlow } from '../src';

describe('FlowValidationError', () => {
  it('carries every issue and lists them in the message', () => {
    const issues = validateFlow({ id: 'demo', name: 'Demo', start: 'x', nodes: {} });
    const error = new FlowValidationError('demo', issues);

    expect(error).toBeInstanceOf(ParafError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FlowValidationError');
    expect(error.code).toBe('FLOW_VALIDATION_FAILED');
    expect(error.issues).toBe(issues);
    expect(error.message).toContain(`Flow "demo" is invalid (${issues.length} issues)`);
    expect(error.message).toContain('[EMPTY_NODES]');
  });

  it('handles a single issue and an unknown flow id', () => {
    const [issue] = validateFlow(null);
    const error = new FlowValidationError(undefined, [issue!]);
    expect(error.message).toMatch(/^Flow is invalid \(1 issue\):/);
  });
});
