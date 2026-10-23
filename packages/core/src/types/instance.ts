import type {
  ApprovalMode,
  ApproverEntry,
  GroupRequirement,
  RejectPolicy,
  ResubmitPolicy,
} from './flow';
import type { JsonObject } from './json';

/** The application document an instance belongs to. Both parts are free-form strings. */
export interface Subject {
  /** Kind of document, e.g. `"purchase_request"`. */
  type: string;
  /** The document's ID in the application, e.g. `"42"` or `"PR/2026/10/007"`. */
  id: string;
}

/**
 * Lifecycle of an instance.
 * - `pending`: waiting for the first decision of the current round.
 * - `in_progress`: at least one decision was made.
 * - `returned`: sent back to the requester for revision.
 * - `approved` / `rejected` / `cancelled`: final.
 */
export type InstanceStatus =
  'pending' | 'in_progress' | 'returned' | 'approved' | 'rejected' | 'cancelled';

/** Statuses in which an instance is still running (at most one per subject). */
export const ACTIVE_INSTANCE_STATUSES: readonly InstanceStatus[] = [
  'pending',
  'in_progress',
  'returned',
];

/** One run of a flow for one application document. */
export interface Instance {
  /** UUID v7. */
  id: string;
  flowId: string;
  /** The flow version this instance runs on, forever. */
  flowVersion: number;
  subject: Subject;
  requesterId: string;
  status: InstanceStatus;
  /** The step waiting for decisions, or `null`. */
  currentStepId: string | null;
  /** Starts at 1 and increases with every resubmission. */
  round: number;
  /** Application data the flow's conditions and resolvers read. */
  document: JsonObject;
  /** Optimistic locking counter, incremented on every update. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/** Lifecycle of a step. */
export type StepStatus = 'active' | 'approved' | 'rejected' | 'skipped' | 'returned' | 'cancelled';

/** Outcome of one approver group within a step. */
export type GroupStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

/** Effective rules of one group, captured when the step was entered. */
export interface StepGroupConfig {
  id: string;
  label?: string;
  mode: ApprovalMode;
  /** Effective minimum for `{ minimum }` mode, after `onInsufficientApprovers: "cap"`. */
  minimum?: number;
  rejectPolicy: RejectPolicy;
  excludeRequester: boolean;
  status: GroupStatus;
}

/** Snapshot of the rules a step runs with. */
export interface StepConfig {
  require: GroupRequirement;
  countAcrossGroups: boolean;
  groups: StepGroupConfig[];
  /** Set when the step was returned to the requester: how to continue after resubmission. */
  resubmitPolicy?: ResubmitPolicy;
  /** Set on approval-chain levels: who the level was resolved for. */
  chain?: StepChainConfig;
}

/** The user an approval-chain level belongs to. */
export interface StepChainConfig {
  /** User the level was resolved from (the origin, or the previous level's user). */
  fromUserId: string;
  /** User the chain returned for this level. */
  userId: string;
  /** Whether `userId` matched the node's `until` (the chain ends after this level). */
  stopper: boolean;
}

/** One visit of an approval node. */
export interface Step {
  /** UUID v7. */
  id: string;
  instanceId: string;
  nodeId: string;
  /** Visit number of this node within the instance, starting at 1. */
  iteration: number;
  /** Level within an approval-chain node; 0 for approval nodes. */
  chainLevel: number;
  /** Instance round the step belongs to. */
  round: number;
  status: StepStatus;
  config: StepConfig;
  enteredAt: Date;
  dueAt: Date | null;
  completedAt: Date | null;
}

/**
 * Status of one approver in one group of a step.
 * `delegated` and `skipped` slots do not count towards the group's decision.
 */
export type ApproverStatus = 'pending' | 'approved' | 'rejected' | 'delegated' | 'skipped';

/** One approver in one group of a step (a user has one slot per group). */
export interface ApproverSlot {
  /** UUID v7. */
  id: string;
  stepId: string;
  instanceId: string;
  groupId: string;
  userId: string;
  /** The approver entry that produced this user, or `null` (e.g. added by delegation). */
  source: ApproverEntry | null;
  status: ApproverStatus;
  /** User who delegated their vote to this slot. */
  delegatedFrom: string | null;
  /** Earlier step whose approval was reused (duplicate approver auto-approve). */
  autoFromStep: string | null;
  decidedAt: Date | null;
  comment: string | null;
}

/** An instance with all its steps and approver slots, as stored. */
export interface InstanceState {
  instance: Instance;
  steps: Step[];
  approvers: ApproverSlot[];
}

/** Actions recorded in the audit trail. */
export type AuditAction =
  | 'started'
  | 'step_entered'
  | 'step_failed'
  | 'approved'
  | 'auto_approved'
  | 'rejected'
  | 'delegated'
  | 'returned'
  | 'resubmitted'
  | 'escalated'
  | 'reresolved'
  | 'skipped'
  | 'condition_evaluated'
  | 'chain_completed'
  | 'cancelled'
  | 'completed';

/** One append-only audit trail entry. */
export interface AuditEntry {
  /** UUID v7. */
  id: string;
  instanceId: string;
  stepId: string | null;
  nodeId: string | null;
  action: AuditAction;
  /** User who acted, or `null` for system actions. */
  actorId: string | null;
  comment: string | null;
  timestamp: Date;
  metadata: JsonObject | null;
}
