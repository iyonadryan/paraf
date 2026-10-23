import type { Instance, Step } from '../types/instance';

/** Approvers of one group that need to act, as carried by `approval.required`. */
export interface RequiredApprovers {
  groupId: string;
  label?: string;
  userIds: string[];
}

/** Why approvers are being asked to act. */
export type ApprovalRequiredReason = 'entered' | 'delegated' | 'reresolved' | 'escalated';

/** A change to the approvers of a group made by `reresolveApprovers`. */
export interface ApproverChange {
  groupId: string;
  userId: string;
}

/** Payloads of the events emitted by the engine, keyed by event name. */
export interface ParafEvents {
  /** A new instance was started. */
  'instance.created': { instance: Instance };
  /** The instance entered an approval step. */
  'step.entered': { instance: Instance; step: Step };
  /** Users must act on a step; use it to send notifications. */
  'approval.required': {
    instance: Instance;
    step: Step;
    reason: ApprovalRequiredReason;
    groups: RequiredApprovers[];
  };
  /** A step finished (approved, rejected, skipped, returned, or cancelled). */
  'step.completed': { instance: Instance; step: Step };
  /** The instance reached a final status (approved, rejected, or cancelled). */
  'instance.completed': { instance: Instance };
  /** A step was returned for revision, to the requester or to an earlier node. */
  'instance.returned': { instance: Instance; step: Step; toNodeId: string | null };
  /** An admin re-resolved the approvers of the active step. */
  'approvers.reresolved': {
    instance: Instance;
    step: Step;
    added: ApproverChange[];
    removed: ApproverChange[];
  };
  /**
   * A step passed its `due_at` and was escalated. `approvers` (possibly empty) can now decide
   * the whole step.
   */
  'timeout.escalated': { instance: Instance; step: Step; approvers: string[] };
}

/** Name of an engine event. */
export type ParafEventName = keyof ParafEvents;

/** Handler of one engine event. */
export type ParafEventHandler<E extends ParafEventName> = (
  payload: ParafEvents[E],
) => void | Promise<void>;

/** Called when an event handler throws. */
export type EventErrorHandler = (
  error: unknown,
  event: { name: ParafEventName; payload: ParafEvents[ParafEventName] },
) => void;

/** An event waiting to be emitted after the action commits. */
export interface QueuedEvent {
  name: ParafEventName;
  payload: ParafEvents[ParafEventName];
}

/** Registers handlers and runs them one after another, reporting failures. */
export class EventBus {
  private readonly handlers = new Map<ParafEventName, Set<(payload: never) => unknown>>();

  constructor(private readonly onError: EventErrorHandler) {}

  on<E extends ParafEventName>(name: E, handler: ParafEventHandler<E>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
    return () => {
      set.delete(handler);
    };
  }

  async emit(events: readonly QueuedEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of [...(this.handlers.get(event.name) ?? [])]) {
        try {
          await (handler as (payload: QueuedEvent['payload']) => unknown)(event.payload);
        } catch (error) {
          this.onError(error, event);
        }
      }
    }
  }
}
