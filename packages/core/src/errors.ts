import type { FlowValidationIssue } from './validation/issues';

/** Base class of every error thrown by Paraf. Check `code` to tell errors apart. */
export class ParafError extends Error {
  /** Stable, machine-readable error code. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown when a flow definition fails validation, e.g. on `publishFlow`. */
export class FlowValidationError extends ParafError {
  /** Every problem found, not just the first. */
  readonly issues: readonly FlowValidationIssue[];

  constructor(flowId: string | undefined, issues: readonly FlowValidationIssue[]) {
    const subject = flowId === undefined ? 'Flow' : `Flow "${flowId}"`;
    const details = issues.map((issue) => `  - [${issue.code}] ${issue.message}`).join('\n');
    super(
      'FLOW_VALIDATION_FAILED',
      `${subject} is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${details}`,
    );
    this.issues = issues;
  }
}
