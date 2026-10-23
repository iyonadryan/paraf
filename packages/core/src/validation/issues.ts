/** Machine-readable codes reported by `validateFlow`. */
export type FlowValidationCode =
  /** The value has the wrong JSON type (e.g. a number where a string is expected). */
  | 'INVALID_TYPE'
  /** A required field is missing. */
  | 'MISSING_FIELD'
  /** A field that is not part of the flow format (often a typo). */
  | 'UNKNOWN_FIELD'
  /** A value outside the allowed set (e.g. an unknown `onEmptyApprovers` policy). */
  | 'INVALID_VALUE'
  /** A flow, node, or group ID that is not a valid slug. */
  | 'INVALID_ID'
  /** `nodes` has no entries. */
  | 'EMPTY_NODES'
  /** A node `type` that is not `approval`, `approval-chain`, `condition`, or `end`. */
  | 'UNKNOWN_NODE_TYPE'
  /** `start`, `next`, `else`, or `onReject` points to a node that does not exist. */
  | 'UNKNOWN_NODE_REFERENCE'
  /** The flow has no `end` node. */
  | 'NO_END_NODE'
  /** A node cannot be reached from `start`. */
  | 'UNREACHABLE_NODE'
  /** A non-`end` node without a way out (missing `next` or `onReject`). */
  | 'DEAD_END'
  /** A loop between nodes; loops are only allowed through `returnForRevision`. */
  | 'CYCLE'
  /** A condition node without `else`. */
  | 'CONDITION_MISSING_ELSE'
  /** A condition node without rules. */
  | 'EMPTY_RULES'
  /** A rule's `when` expression is malformed. */
  | 'INVALID_CONDITION'
  /** An approval node with both `approvers` and `groups`. */
  | 'APPROVERS_AND_GROUPS'
  /** An approval node with neither `approvers` nor `groups`. */
  | 'MISSING_APPROVERS'
  /** Single-group fields on a node with `groups`, or group-only fields on a single-group node. */
  | 'CONFLICTING_FIELD'
  /** An empty `approvers`, `groups`, `fallbackApprovers`, or timeout `to` list. */
  | 'EMPTY_APPROVERS'
  /** Two groups of one node share an `id`. */
  | 'DUPLICATE_GROUP_ID'
  /** `require: { minimum }` is not an integer between 1 and the number of groups. */
  | 'INVALID_REQUIRE'
  /** `mode: { minimum }` is not an integer >= 1. */
  | 'INVALID_MINIMUM'
  /** `rejectPolicy: { minimum }` is not an integer >= 1. */
  | 'INVALID_REJECT_POLICY'
  /** A group of only `user` approvers lists fewer unique users than `mode.minimum`. */
  | 'MINIMUM_EXCEEDS_APPROVERS'
  /** A `"fallback"` policy without `fallbackApprovers`. */
  | 'MISSING_FALLBACK_APPROVERS'
  /** An approver `type` that is not registered (checked when `approverTypes` is given). */
  | 'UNKNOWN_APPROVER_TYPE'
  /** Invalid configuration for a built-in approver type (`user`, `field`). */
  | 'INVALID_APPROVER_CONFIG'
  /** An approval-chain node without `chain`. */
  | 'MISSING_CHAIN'
  /** A `chain` that is not registered (checked when `chains` is given). */
  | 'UNKNOWN_CHAIN'
  /** `maxLevels` is missing or not an integer >= 1. */
  | 'INVALID_MAX_LEVELS'
  /** `timeout.after` is not an ISO 8601 duration. */
  | 'INVALID_DURATION';

/** One problem found by `validateFlow`. */
export interface FlowValidationIssue {
  /** What kind of problem this is. */
  code: FlowValidationCode;
  /** Human-readable explanation that names the node and group involved. */
  message: string;
  /** Location in the flow document, e.g. `nodes.review.groups[1].mode`. */
  path: string;
  /** Node the problem belongs to, if any. */
  nodeId?: string;
  /** Group the problem belongs to, if any. */
  groupId?: string;
}
