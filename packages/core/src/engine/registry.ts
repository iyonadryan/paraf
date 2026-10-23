import { readPath } from '../condition/evaluate';
import type { ApproverEntry } from '../types/flow';
import type { Instance, Subject } from '../types/instance';
import type { JsonObject } from '../types/json';

/** What a resolver knows about the instance it resolves approvers for. */
export interface ResolverContext {
  requester: { id: string };
  subject: Subject;
  /** The instance's document. */
  document: JsonObject;
  /** The instance (a copy; changes are ignored). */
  instance: Instance;
  /** Node being entered. */
  nodeId: string;
  /** Group being resolved (`"default"` for single-group nodes). */
  groupId: string;
}

/** What a chain resolver knows about the instance it walks the chain for. */
export interface ChainContext extends Omit<ResolverContext, 'groupId'> {
  /** Level being resolved, starting at 1. */
  level: number;
}

/**
 * Returns the next user up a chain from `fromUserId` (e.g. their supervisor), or `null` at the
 * top of the chain.
 */
export type ChainResolver = (
  fromUserId: string,
  context: ChainContext,
) => string | null | undefined | Promise<string | null | undefined>;

/** Editor metadata of a chain. */
export interface ChainMeta {
  /** Human-readable name, e.g. "Supervisors". */
  label?: string;
}

/** A registered chain as reported by `engine.getChains()`. */
export interface ChainInfo {
  name: string;
  label: string;
}

/** Chains known to an engine. */
export class ChainRegistry {
  private readonly chains = new Map<string, { resolver: ChainResolver; meta: ChainMeta }>();

  register(name: string, resolver: ChainResolver, meta: ChainMeta = {}): void {
    if (name === '') throw new TypeError('Paraf: a chain needs a non-empty name.');
    this.chains.set(name, { resolver, meta });
  }

  get(name: string): ChainResolver | undefined {
    return this.chains.get(name)?.resolver;
  }

  names(): string[] {
    return [...this.chains.keys()];
  }

  list(): ChainInfo[] {
    return [...this.chains].map(([name, { meta }]) => ({ name, label: meta.label ?? name }));
  }
}

/**
 * Turns an approver entry into user IDs, e.g. all users with a role. May return the same ID
 * more than once; results are deduplicated.
 */
export type ApproverResolver = (
  config: ApproverEntry,
  context: ResolverContext,
) => string[] | Promise<string[]>;

/** A choice for `select` / `multiselect` configuration fields. */
export interface ConfigOption {
  value: string;
  label: string;
}

/** One configuration field of an approver type, used by the editor to build its form. */
export interface ConfigField {
  type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect';
  label: string;
  required?: boolean;
  /** Choices for `select` and `multiselect`; may be loaded lazily. */
  options?: ConfigOption[] | (() => ConfigOption[] | Promise<ConfigOption[]>);
}

/** Editor metadata of an approver type. */
export interface ApproverTypeMeta {
  /** Human-readable name, e.g. "By role". */
  label?: string;
  /** Form fields keyed by approver entry property. */
  configSchema?: Record<string, ConfigField>;
}

/** A registered approver type as reported by `engine.getApproverTypes()`. */
export interface ApproverTypeInfo extends ApproverTypeMeta {
  type: string;
  label: string;
}

interface RegisteredType {
  resolver: ApproverResolver;
  meta: ApproverTypeMeta;
}

function toIds(value: unknown): string[] {
  const values = Array.isArray(value) ? (value as unknown[]) : [value];
  return values.filter((id): id is string => typeof id === 'string' && id !== '');
}

/** Approver types known to an engine, starting with the built-in `user` and `field`. */
export class ApproverTypeRegistry {
  private readonly types = new Map<string, RegisteredType>();

  constructor() {
    this.types.set('user', {
      resolver: (config) => toIds(config.value),
      meta: {
        label: 'Specific users',
        configSchema: { value: { type: 'multiselect', label: 'Users', required: true } },
      },
    });
    this.types.set('field', {
      resolver: (config, context) =>
        typeof config.value === 'string' ? toIds(readPath(context.document, config.value)) : [],
      meta: {
        label: 'User from a document field',
        configSchema: { value: { type: 'text', label: 'Field path', required: true } },
      },
    });
  }

  register(type: string, resolver: ApproverResolver, meta: ApproverTypeMeta = {}): void {
    if (type === '') throw new TypeError('Paraf: an approver type needs a non-empty name.');
    this.types.set(type, { resolver, meta });
  }

  get(type: string): ApproverResolver | undefined {
    return this.types.get(type)?.resolver;
  }

  names(): string[] {
    return [...this.types.keys()];
  }

  list(): ApproverTypeInfo[] {
    return [...this.types].map(([type, { meta }]) => ({
      ...meta,
      type,
      label: meta.label ?? type,
    }));
  }
}
