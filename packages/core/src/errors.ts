import type { DocumentProblem } from './document';
import type { Subject } from './types/instance';
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

/** A flow (or a specific version of it) does not exist or has no active version. */
export class FlowNotFoundError extends ParafError {
  readonly flowId: string;
  readonly version: number | undefined;

  constructor(flowId: string, version?: number) {
    super(
      'FLOW_NOT_FOUND',
      version === undefined
        ? `Flow "${flowId}" does not exist or has no active version.`
        : `Flow "${flowId}" has no version ${version}.`,
    );
    this.flowId = flowId;
    this.version = version;
  }
}

/** Thrown by stores when saving a flow version that already exists. */
export class FlowVersionExistsError extends ParafError {
  readonly flowId: string;
  readonly version: number;

  constructor(flowId: string, version: number) {
    super('FLOW_VERSION_EXISTS', `Flow "${flowId}" version ${version} already exists.`);
    this.flowId = flowId;
    this.version = version;
  }
}

/** No instance with the given ID. */
export class InstanceNotFoundError extends ParafError {
  readonly instanceId: string;

  constructor(instanceId: string) {
    super('INSTANCE_NOT_FOUND', `Instance "${instanceId}" does not exist.`);
    this.instanceId = instanceId;
  }
}

/** The subject already has an active instance (`pending`, `in_progress`, or `returned`). */
export class ActiveInstanceExistsError extends ParafError {
  readonly subject: Subject;

  constructor(subject: Subject) {
    super(
      'ACTIVE_INSTANCE_EXISTS',
      `Subject ${subject.type}:${subject.id} already has an active approval instance.`,
    );
    this.subject = { type: subject.type, id: subject.id };
  }
}

/** Context of an error raised while performing an action on an instance. */
export interface ActionErrorContext {
  action: string;
  instanceId?: string;
  userId?: string;
  nodeId?: string;
  groupId?: string;
}

function describeContext(context: ActionErrorContext): string {
  const parts = [`action "${context.action}"`];
  if (context.instanceId !== undefined) parts.push(`instance "${context.instanceId}"`);
  if (context.nodeId !== undefined) parts.push(`node "${context.nodeId}"`);
  if (context.groupId !== undefined) parts.push(`group "${context.groupId}"`);
  if (context.userId !== undefined) parts.push(`user "${context.userId}"`);
  return parts.join(', ');
}

/** Base class of errors raised by instance actions; carries where the error happened. */
export class ActionError extends ParafError {
  readonly context: ActionErrorContext;

  constructor(code: string, message: string, context: ActionErrorContext) {
    super(code, `${message} (${describeContext(context)})`);
    this.context = context;
  }
}

/** The user may not perform the action (e.g. not a pending approver, not the requester). */
export class NotAuthorizedError extends ActionError {
  constructor(message: string, context: ActionErrorContext) {
    super('NOT_AUTHORIZED', message, context);
  }
}

/** The instance is not in a status that allows the action. */
export class InvalidStateError extends ActionError {
  constructor(message: string, context: ActionErrorContext) {
    super('INVALID_STATE', message, context);
  }
}

/** An argument is malformed (e.g. an empty subject id or a missing comment). */
export class InvalidArgumentError extends ActionError {
  constructor(message: string, context: ActionErrorContext) {
    super('INVALID_ARGUMENT', message, context);
  }
}

/** The document does not match the flow's variables (missing required values, wrong types). */
export class DocumentValidationError extends ActionError {
  readonly problems: readonly DocumentProblem[];

  constructor(problems: readonly DocumentProblem[], context: ActionErrorContext) {
    super(
      'DOCUMENT_INVALID',
      `The document is invalid: ${problems.map((problem) => problem.message).join('; ')}`,
      context,
    );
    this.problems = problems;
  }
}

/** The instance kept changing concurrently and the action gave up after retrying. */
export class ConcurrencyError extends ActionError {
  readonly attempts: number;

  constructor(attempts: number, context: ActionErrorContext) {
    super(
      'CONCURRENCY_CONFLICT',
      `The instance was modified concurrently; gave up after ${attempts} attempts`,
      context,
    );
    this.attempts = attempts;
  }
}

/** Where a step could not be entered: always a node and one of its groups. */
export interface StepEntryErrorContext extends ActionErrorContext {
  nodeId: string;
  groupId: string;
}

/** Base class of errors that prevent an instance from entering a step. */
export class StepEntryError extends ActionError {
  declare readonly context: StepEntryErrorContext;
}

/** Approver resolution returned nobody and the policy is `onEmptyApprovers: "error"`. */
export class EmptyApproversError extends StepEntryError {
  constructor(context: StepEntryErrorContext) {
    super('EMPTY_APPROVERS', 'No approvers were resolved', context);
  }
}

/** Fewer approvers than `mode.minimum` were resolved and could not be made up. */
export class InsufficientApproversError extends StepEntryError {
  readonly found: number;
  readonly minimum: number;

  constructor(found: number, minimum: number, context: StepEntryErrorContext) {
    super(
      'INSUFFICIENT_APPROVERS',
      `Found ${found} approver(s) but the group needs at least ${minimum}`,
      context,
    );
    this.found = found;
    this.minimum = minimum;
  }
}

/** A flow uses an approver type that is not registered with the engine. */
export class UnknownApproverTypeError extends StepEntryError {
  readonly approverType: string;

  constructor(approverType: string, context: StepEntryErrorContext) {
    super('UNKNOWN_APPROVER_TYPE', `Approver type "${approverType}" is not registered`, context);
    this.approverType = approverType;
  }
}

/** A flow uses a chain that is not registered with the engine. */
export class UnknownChainError extends StepEntryError {
  readonly chain: string;

  constructor(chain: string, context: StepEntryErrorContext) {
    super('UNKNOWN_CHAIN', `Chain "${chain}" is not registered`, context);
    this.chain = chain;
  }
}

/** An approval chain returned a user it already passed (e.g. A → B → A). */
export class ChainCycleError extends StepEntryError {
  /** Users in chain order, ending with the repeated one. */
  readonly path: readonly string[];

  constructor(path: readonly string[], context: StepEntryErrorContext) {
    super('CHAIN_CYCLE', `Approval chain loops: ${path.join(' → ')}`, context);
    this.path = path;
  }
}

/** A delegation is not allowed (e.g. to oneself, or it would make a minimum unreachable). */
export class DelegationError extends ActionError {
  constructor(message: string, context: ActionErrorContext) {
    super('INVALID_DELEGATION', message, context);
  }
}

/** A condition could not be evaluated (e.g. an operator that is no longer registered). */
export class ConditionEvaluationError extends ParafError {
  constructor(message: string) {
    super('CONDITION_EVALUATION_FAILED', message);
  }
}
