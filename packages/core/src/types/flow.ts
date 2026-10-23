import type { JsonValue } from './json';

/**
 * One source of approvers, resolved at runtime by the resolver registered for `type`.
 *
 * Built-in types:
 * - `{ type: 'user', value: 'u1' | ['u1', 'u2'] }`: fixed user IDs.
 * - `{ type: 'field', value: 'pic_user_id' }`: user ID(s) read from a path in the document.
 *
 * Every other property is resolver-specific configuration (for example `value` for a role
 * resolver or `level` for a supervisor resolver).
 */
export interface ApproverEntry {
  /** Name of a registered approver type, e.g. `"role"`. */
  type: string;
  [config: string]: JsonValue | undefined;
}

/**
 * How many approvals a group needs.
 * - `"any"`: one approval is enough.
 * - `"all"`: every resolved approver must approve.
 * - `{ minimum: n }`: at least `n` approvals (`n` is an integer >= 1).
 */
export type ApprovalMode = 'any' | 'all' | { minimum: number };

/**
 * When a group counts as rejected.
 * - `"any"`: the first rejection fails the group. Default for modes `any` and `all`.
 * - `"impossible"`: fails once approvals plus pending approvers can no longer reach the
 *   minimum. Default for mode `{ minimum }`.
 * - `{ minimum: n }`: fails after `n` rejections.
 */
export type RejectPolicy = 'any' | 'impossible' | { minimum: number };

/**
 * How many groups of an approval node must be satisfied.
 * `"all"` (default), `"any"`, or `{ minimum: n }` groups.
 */
export type GroupRequirement = 'all' | 'any' | { minimum: number };

/**
 * What happens when approver resolution returns nobody.
 * - `"error"` (default): entering the step fails.
 * - `"skip"`: the group (or chain node) counts as satisfied; recorded in the audit trail.
 * - `"fallback"`: use `fallbackApprovers` instead.
 */
export type EmptyApproversPolicy = 'error' | 'skip' | 'fallback';

/**
 * What happens when fewer approvers are resolved than `mode.minimum` requires.
 * - `"error"` (default): entering the step fails with `InsufficientApproversError`.
 * - `"cap"`: lower the minimum to the number of available approvers.
 * - `"fallback"`: add `fallbackApprovers` until there are enough; if still short, behave as
 *   `"error"`.
 */
export type InsufficientApproversPolicy = 'error' | 'cap' | 'fallback';

/**
 * How a user who already approved an earlier step of the same round is treated.
 * - `"require"` (default): they must approve again.
 * - `"auto-approve"`: their slot is approved automatically.
 */
export type DuplicateApproverPolicy = 'require' | 'auto-approve';

/**
 * Where a returned-and-resubmitted instance continues.
 * - `"restart"` (default): from the flow's `start` node; every level approves again.
 * - `"resume"`: from the node that returned the document.
 */
export type ResubmitPolicy = 'restart' | 'resume';

/** Escalation settings for a step that has not completed in time. */
export interface TimeoutConfig {
  /** ISO 8601 duration after which the timeout fires, e.g. `"P3D"` or `"PT12H"`. */
  after: string;
  /** Action to take. */
  action: 'escalate';
  /** Approvers added to the step when escalating. */
  to: ApproverEntry[];
}

/** Settings shared by a single-group approval node and each entry of `groups`. */
export interface ApproverGroupRules {
  /** Approver sources. Results are merged and deduplicated. */
  approvers: ApproverEntry[];
  /** How many approvals are needed. */
  mode: ApprovalMode;
  /** When the group counts as rejected. Default depends on `mode`. */
  rejectPolicy?: RejectPolicy;
  /** Remove the requester from the resolved approvers. Default `false`. */
  excludeRequester?: boolean;
  /** Behaviour when nobody is resolved. Default `"error"`. */
  onEmptyApprovers?: EmptyApproversPolicy;
  /** Behaviour when fewer than `mode.minimum` approvers are resolved. Default `"error"`. */
  onInsufficientApprovers?: InsufficientApproversPolicy;
  /** Approvers used by the `"fallback"` policies. */
  fallbackApprovers?: ApproverEntry[];
}

/** One group of approvers inside an approval node. */
export interface ApproverGroup extends ApproverGroupRules {
  /** Slug, unique within the node. */
  id: string;
  /** Human-readable name. */
  label?: string;
}

interface NodeBase {
  /** Human-readable name shown in the editor and in notifications. */
  label?: string;
}

interface ApprovalNodeBase extends NodeBase {
  type: 'approval';
  /** Same-person handling across steps. Default `"require"`. */
  duplicateApprover?: DuplicateApproverPolicy;
  /** Escalation when the step is not completed in time. */
  timeout?: TimeoutConfig;
  /** Node to continue with once the step is approved. */
  next: string;
  /** Node to continue with once the step is rejected. */
  onReject: string;
}

/**
 * Approval node with a single group (short form). Treated as one group with id `"default"`
 * and `require: "all"`.
 */
export interface SingleGroupApprovalNode extends ApprovalNodeBase, ApproverGroupRules {
  groups?: never;
  require?: never;
  countAcrossGroups?: never;
}

/** Approval node with several groups evaluated in parallel. */
export interface MultiGroupApprovalNode extends ApprovalNodeBase {
  /** Groups that are notified at the same time. */
  groups: ApproverGroup[];
  /** How many groups must be satisfied. Default `"all"`. */
  require?: GroupRequirement;
  /**
   * When a user belongs to several groups, count their decision in all of them (`true`,
   * default) or only in the first group that contains them (`false`).
   */
  countAcrossGroups?: boolean;
  approvers?: never;
  mode?: never;
  rejectPolicy?: never;
  excludeRequester?: never;
  onEmptyApprovers?: never;
  onInsufficientApprovers?: never;
  fallbackApprovers?: never;
}

/** A step that waits for approvals. */
export type ApprovalNode = SingleGroupApprovalNode | MultiGroupApprovalNode;

/** Where an approval chain starts walking from. */
export type ChainOrigin = 'requester' | { field: string };

/**
 * Walks a registered chain (e.g. supervisors) level by level, creating one step per level,
 * until `until` matches, the chain ends, or `maxLevels` is reached.
 */
export interface ApprovalChainNode extends NodeBase {
  type: 'approval-chain';
  /** Name of a chain registered with `engine.registerChain()`. */
  chain: string;
  /** Starting user. Default `"requester"`. */
  from?: ChainOrigin;
  /** Stop once the current level's approver is among the users this entry resolves to. */
  until?: ApproverEntry;
  /** Whether the user who matched `until` must still approve. Default `true`. */
  includeStopper?: boolean;
  /** Safety limit on the number of levels (integer >= 1). */
  maxLevels: number;
  /** Same-person handling across steps. Default `"require"`. */
  duplicateApprover?: DuplicateApproverPolicy;
  /** Skip levels whose approver is the requester. Default `false`. */
  excludeRequester?: boolean;
  /** Behaviour when the chain is empty from the start. Default `"error"`. */
  onEmptyApprovers?: EmptyApproversPolicy;
  /** Approvers used when `onEmptyApprovers` is `"fallback"`. */
  fallbackApprovers?: ApproverEntry[];
  /** Escalation when a level is not completed in time. */
  timeout?: TimeoutConfig;
  /** Node to continue with once every level approved. */
  next: string;
  /** Node to continue with when any level rejects. */
  onReject: string;
}

/**
 * A condition expression in JSON Logic style, e.g. `{ ">": [{ "var": "amount" }, 1000] }`.
 * Built-in operators: `==`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `and`, `or`, `not`, `var`.
 */
export type ConditionExpression = JsonValue;

/** One branch of a condition node. */
export interface ConditionRule {
  /** Expression evaluated against the document. */
  when: ConditionExpression;
  /** Node to continue with when `when` is truthy. */
  next: string;
  /** Label for the branch, shown on the editor edge. */
  label?: string;
}

/** Routes the instance to the first rule whose expression is truthy, otherwise to `else`. */
export interface ConditionNode extends NodeBase {
  type: 'condition';
  /** Rules evaluated in order. */
  rules: ConditionRule[];
  /** Node to continue with when no rule matches. */
  else: string;
}

/** Final outcome of an instance. */
export type EndResult = 'approved' | 'rejected';

/** Terminates the instance with the given result. */
export interface EndNode extends NodeBase {
  type: 'end';
  result: EndResult;
}

/** Any node of a flow. */
export type FlowNode = ApprovalNode | ApprovalChainNode | ConditionNode | EndNode;

/** Discriminator of {@link FlowNode}. */
export type FlowNodeType = FlowNode['type'];

/** Canvas position of a node; used by the editor only. */
export interface NodePosition {
  x: number;
  y: number;
}

/** Type of a document variable. */
export type DocumentVariableType = 'number' | 'text' | 'select' | 'date' | 'boolean' | 'user';

/**
 * A piece of document data the flow uses (in conditions and approvers). `engine.start` and
 * `resubmit` reject documents whose variables are missing (when required) or of the wrong type.
 */
export interface DocumentVariable {
  /** Path in the document, e.g. `"amount"` or `"pic.user_id"`. */
  key: string;
  /** Human-readable name. */
  label?: string;
  /**
   * - `number`: a finite number; `text`: a string; `select`: one of `options`;
   * - `date`: an ISO 8601 date or date-time string; `boolean`: true or false;
   * - `user`: a user ID (non-empty string).
   */
  type: DocumentVariableType;
  /** Allowed values of a `select` variable. */
  options?: string[];
  /** The document must contain a value. Default `false`. */
  required?: boolean;
}

/** An approval flow, stored and versioned as JSON. */
export interface FlowDefinition {
  /** Slug identifying the flow, e.g. `"purchase-request"`. */
  id: string;
  /** Version number (integer >= 1). Assigned when the flow is published. */
  version?: number;
  /** Human-readable name. */
  name: string;
  /** ID of the first node. */
  start: string;
  /** Default behaviour after resubmission. Default `"restart"`. */
  resubmitPolicy?: ResubmitPolicy;
  /** Document data the flow expects, checked when an instance starts or is resubmitted. */
  variables?: DocumentVariable[];
  /** Nodes keyed by their slug ID. */
  nodes: Record<string, FlowNode>;
  /** Node positions for the editor; ignored by the engine. */
  layout?: Record<string, NodePosition>;
}

/** A flow definition as stored: always has a `version`. */
export interface PublishedFlow extends FlowDefinition {
  version: number;
}
