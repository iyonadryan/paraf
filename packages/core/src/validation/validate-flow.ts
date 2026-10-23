import { validateExpression } from '../condition/validate-expression';
import { parseDuration } from '../duration';
import type { FlowValidationCode, FlowValidationIssue } from './issues';

/** Registries to check a flow against. Omitted registries are not checked. */
export interface ValidateFlowOptions {
  /** Registered approver types. The built-in `user` and `field` are always allowed. */
  approverTypes?: readonly string[];
  /** Registered chain names (for `approval-chain` nodes). */
  chains?: readonly string[];
  /** Custom condition operators registered on top of the built-in ones. */
  operators?: readonly string[];
}

/** Flow, node, and group IDs: letters, digits, `_` and `-`, up to 100 characters. */
export const SLUG_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$';
const SLUG_REGEX = new RegExp(SLUG_PATTERN);

const BUILTIN_APPROVER_TYPES = ['user', 'field'];
const NODE_TYPES = ['approval', 'approval-chain', 'condition', 'end'];

const FLOW_FIELDS = [
  'id',
  'version',
  'name',
  'start',
  'resubmitPolicy',
  'variables',
  'nodes',
  'layout',
];
const VARIABLE_FIELDS = ['key', 'label', 'type', 'options', 'required'];
const VARIABLE_TYPES = ['number', 'text', 'select', 'date', 'boolean', 'user'];

/** Document variable keys: dot-separated identifiers, e.g. `amount` or `pic.user_id`. */
export const VARIABLE_KEY_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)*$';
const VARIABLE_KEY_REGEX = new RegExp(VARIABLE_KEY_PATTERN);
const GROUP_RULE_FIELDS = [
  'approvers',
  'mode',
  'rejectPolicy',
  'excludeRequester',
  'onEmptyApprovers',
  'onInsufficientApprovers',
  'fallbackApprovers',
];
const MULTI_GROUP_FIELDS = ['groups', 'require', 'countAcrossGroups'];
const APPROVAL_FIELDS = [
  'type',
  'label',
  'duplicateApprover',
  'timeout',
  'next',
  'onReject',
  ...GROUP_RULE_FIELDS,
  ...MULTI_GROUP_FIELDS,
];
const GROUP_FIELDS = ['id', 'label', ...GROUP_RULE_FIELDS];
const CHAIN_FIELDS = [
  'type',
  'label',
  'chain',
  'from',
  'until',
  'includeStopper',
  'maxLevels',
  'duplicateApprover',
  'excludeRequester',
  'onEmptyApprovers',
  'fallbackApprovers',
  'timeout',
  'next',
  'onReject',
];
const CONDITION_FIELDS = ['type', 'label', 'rules', 'else'];
const RULE_FIELDS = ['when', 'next', 'label'];
const END_FIELDS = ['type', 'label', 'result'];
const TIMEOUT_FIELDS = ['after', 'action', 'to'];

type Obj = Record<string, unknown>;

interface Scope {
  nodeId?: string;
  groupId?: string;
}

/** Scope of something inside a node, such as a reference to another node. */
interface NodeScope extends Scope {
  nodeId: string;
}

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Short description of a value for error messages. */
function describe(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return value === null ? 'null' : Array.isArray(value) ? 'an array' : 'an object';
    case 'function':
      return 'a function';
    default:
      return String(value);
  }
}

function list(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

/**
 * Validates a flow definition and returns every problem found (an empty array means the flow
 * is valid). Accepts `unknown` so it can check JSON from any source, such as an editor import.
 *
 * Checks the shape of every node and group, that `start`/`next`/`else`/`onReject` point to
 * existing nodes, that there is an `end` node, that every node is reachable and has a way out,
 * that there are no loops (loops are only possible through `returnForRevision`), condition
 * expressions, approval modes and policies, and (when the registries are given) that approver
 * types and chains are registered.
 */
export function validateFlow(
  flow: unknown,
  options: ValidateFlowOptions = {},
): FlowValidationIssue[] {
  return new FlowValidator(options).run(flow);
}

class FlowValidator {
  private readonly issues: FlowValidationIssue[] = [];
  private readonly approverTypes: ReadonlySet<string> | undefined;
  private readonly chains: ReadonlySet<string> | undefined;
  private readonly operators: ReadonlySet<string>;
  private nodeIds: ReadonlySet<string> = new Set();
  private readonly edges = new Map<string, string[]>();

  constructor(options: ValidateFlowOptions) {
    this.approverTypes = options.approverTypes
      ? new Set([...BUILTIN_APPROVER_TYPES, ...options.approverTypes])
      : undefined;
    this.chains = options.chains ? new Set(options.chains) : undefined;
    this.operators = new Set(options.operators ?? []);
  }

  run(flow: unknown): FlowValidationIssue[] {
    if (!isObject(flow)) {
      this.report(
        'INVALID_TYPE',
        '',
        {},
        `Flow definition must be an object, got ${describe(flow)}.`,
      );
      return this.issues;
    }

    this.checkUnknownFields(flow, FLOW_FIELDS, '', {});
    this.checkSlug(flow, 'id', 'id', {}, 'Flow id');
    if ('version' in flow && !isPositiveInteger(flow.version)) {
      this.report(
        'INVALID_VALUE',
        'version',
        {},
        `"version" must be an integer >= 1, got ${describe(flow.version)}.`,
      );
    }
    this.checkString(flow, 'name', 'name', {}, { required: true });
    this.checkEnum(flow, 'resubmitPolicy', ['restart', 'resume'], 'resubmitPolicy', {});

    const nodes = flow.nodes;
    if (nodes === undefined) {
      this.report('MISSING_FIELD', 'nodes', {}, '"nodes" is required.');
    } else if (!isObject(nodes)) {
      this.report(
        'INVALID_TYPE',
        'nodes',
        {},
        `"nodes" must be an object keyed by node id, got ${describe(nodes)}.`,
      );
    } else {
      this.nodeIds = new Set(Object.keys(nodes));
      if (this.nodeIds.size === 0) {
        this.report('EMPTY_NODES', 'nodes', {}, 'A flow needs at least one node.');
      }
      for (const [nodeId, node] of Object.entries(nodes)) {
        this.checkNode(nodeId, node);
      }
      this.checkGraph(flow, nodes);
    }

    if ('variables' in flow) this.checkVariables(flow.variables);
    if ('layout' in flow) this.checkLayout(flow.layout);
    return this.issues;
  }

  // ---------------------------------------------------------------------------------------
  // Nodes
  // ---------------------------------------------------------------------------------------

  private checkNode(nodeId: string, node: unknown): void {
    const path = `nodes.${nodeId}`;
    const scope: NodeScope = { nodeId };
    if (!SLUG_REGEX.test(nodeId)) {
      this.report(
        'INVALID_ID',
        path,
        scope,
        `Node id "${nodeId}" must be a slug (letters, digits, "_" and "-", max 100 characters).`,
      );
    }
    if (!isObject(node)) {
      this.report('INVALID_TYPE', path, scope, `Node must be an object, got ${describe(node)}.`);
      return;
    }
    if (!('type' in node)) {
      this.report('MISSING_FIELD', `${path}.type`, scope, '"type" is required.');
      return;
    }
    if (typeof node.type !== 'string' || !NODE_TYPES.includes(node.type)) {
      this.report(
        'UNKNOWN_NODE_TYPE',
        `${path}.type`,
        scope,
        `Unknown node type ${describe(node.type)}; expected one of ${list(NODE_TYPES)}.`,
      );
      return;
    }
    this.checkString(node, 'label', `${path}.label`, scope);

    switch (node.type) {
      case 'approval':
        this.checkApprovalNode(node, path, scope);
        break;
      case 'approval-chain':
        this.checkChainNode(node, path, scope);
        break;
      case 'condition':
        this.checkConditionNode(node, path, scope);
        break;
      default:
        this.checkUnknownFields(node, END_FIELDS, path, scope);
        if (!('result' in node)) {
          this.report(
            'MISSING_FIELD',
            `${path}.result`,
            scope,
            '"result" is required ("approved" or "rejected").',
          );
        } else {
          this.checkEnum(node, 'result', ['approved', 'rejected'], `${path}.result`, scope);
        }
    }
  }

  private checkApprovalNode(node: Obj, path: string, scope: NodeScope): void {
    this.checkUnknownFields(node, APPROVAL_FIELDS, path, scope);
    this.checkEnum(
      node,
      'duplicateApprover',
      ['require', 'auto-approve'],
      `${path}.duplicateApprover`,
      scope,
    );
    this.checkTimeout(node, path, scope);
    this.checkReference(node, 'next', path, scope);
    this.checkReference(node, 'onReject', path, scope);

    const hasApprovers = 'approvers' in node;
    const hasGroups = 'groups' in node;
    if (hasApprovers && hasGroups) {
      this.report(
        'APPROVERS_AND_GROUPS',
        path,
        scope,
        'Use either "approvers" (single group) or "groups", not both.',
      );
      return;
    }
    if (!hasApprovers && !hasGroups) {
      this.report(
        'MISSING_APPROVERS',
        path,
        scope,
        'An approval node needs "approvers" or "groups".',
      );
      return;
    }

    if (hasApprovers) {
      for (const field of MULTI_GROUP_FIELDS) {
        if (field in node) {
          this.report(
            'CONFLICTING_FIELD',
            `${path}.${field}`,
            scope,
            `"${field}" only applies to nodes with "groups".`,
          );
        }
      }
      this.checkGroupRules(node, path, scope);
      return;
    }

    for (const field of GROUP_RULE_FIELDS) {
      if (field !== 'approvers' && field in node) {
        this.report(
          'CONFLICTING_FIELD',
          `${path}.${field}`,
          scope,
          `"${field}" must be set on each group when the node uses "groups".`,
        );
      }
    }
    const groups = node.groups;
    if (!Array.isArray(groups)) {
      this.report(
        'INVALID_TYPE',
        `${path}.groups`,
        scope,
        `"groups" must be an array, got ${describe(groups)}.`,
      );
      return;
    }
    if (groups.length === 0) {
      this.report(
        'EMPTY_APPROVERS',
        `${path}.groups`,
        scope,
        '"groups" must contain at least one group.',
      );
    }

    const seen = new Set<string>();
    groups.forEach((group: unknown, index) => {
      const groupPath = `${path}.groups[${index}]`;
      if (!isObject(group)) {
        this.report(
          'INVALID_TYPE',
          groupPath,
          scope,
          `Group #${index + 1} must be an object, got ${describe(group)}.`,
        );
        return;
      }
      const groupScope: Scope =
        typeof group.id === 'string' ? { nodeId: scope.nodeId, groupId: group.id } : scope;
      this.checkUnknownFields(group, GROUP_FIELDS, groupPath, groupScope);
      if (this.checkSlug(group, 'id', `${groupPath}.id`, groupScope, `Group id`)) {
        const id = group.id as string;
        if (seen.has(id)) {
          this.report(
            'DUPLICATE_GROUP_ID',
            `${groupPath}.id`,
            groupScope,
            `Group id "${id}" is used more than once in this node.`,
          );
        }
        seen.add(id);
      }
      this.checkString(group, 'label', `${groupPath}.label`, groupScope);
      this.checkGroupRules(group, groupPath, groupScope);
    });

    if ('require' in node) {
      const requirement = node.require;
      if (isObject(requirement)) {
        const minimum = this.checkMinimumObject(
          requirement,
          `${path}.require`,
          scope,
          'INVALID_REQUIRE',
          'require.minimum',
        );
        if (minimum !== undefined && minimum > groups.length) {
          this.report(
            'INVALID_REQUIRE',
            `${path}.require.minimum`,
            scope,
            `require.minimum (${minimum}) cannot exceed the number of groups (${groups.length}).`,
          );
        }
      } else if (requirement !== 'all' && requirement !== 'any') {
        this.report(
          'INVALID_REQUIRE',
          `${path}.require`,
          scope,
          `"require" must be "all", "any", or { "minimum": n }, got ${describe(requirement)}.`,
        );
      }
    }
    this.checkBoolean(node, 'countAcrossGroups', `${path}.countAcrossGroups`, scope);
  }

  /** Checks the fields shared by a single-group node and each entry of `groups`. */
  private checkGroupRules(target: Obj, path: string, scope: Scope): void {
    const approvers = this.checkApproverList(target, 'approvers', path, scope, true);

    let minimum: number | undefined;
    const mode = target.mode;
    if (!('mode' in target)) {
      this.report(
        'MISSING_FIELD',
        `${path}.mode`,
        scope,
        '"mode" is required ("any", "all", or { "minimum": n }).',
      );
    } else if (isObject(mode)) {
      minimum = this.checkMinimumObject(
        mode,
        `${path}.mode`,
        scope,
        'INVALID_MINIMUM',
        'mode.minimum',
      );
    } else if (mode !== 'any' && mode !== 'all') {
      this.report(
        'INVALID_VALUE',
        `${path}.mode`,
        scope,
        `"mode" must be "any", "all", or { "minimum": n }, got ${describe(mode)}.`,
      );
    }

    if ('rejectPolicy' in target) {
      const policy = target.rejectPolicy;
      if (isObject(policy)) {
        this.checkMinimumObject(
          policy,
          `${path}.rejectPolicy`,
          scope,
          'INVALID_REJECT_POLICY',
          'rejectPolicy.minimum',
        );
      } else if (policy !== 'any' && policy !== 'impossible') {
        this.report(
          'INVALID_REJECT_POLICY',
          `${path}.rejectPolicy`,
          scope,
          `"rejectPolicy" must be "any", "impossible", or { "minimum": n }, got ${describe(policy)}.`,
        );
      }
    }

    this.checkBoolean(target, 'excludeRequester', `${path}.excludeRequester`, scope);
    this.checkEnum(
      target,
      'onEmptyApprovers',
      ['error', 'skip', 'fallback'],
      `${path}.onEmptyApprovers`,
      scope,
    );
    this.checkEnum(
      target,
      'onInsufficientApprovers',
      ['error', 'cap', 'fallback'],
      `${path}.onInsufficientApprovers`,
      scope,
    );
    this.checkFallback(target, path, scope);

    if (
      minimum !== undefined &&
      approvers.length > 0 &&
      approvers.every((entry) => entry.type === 'user')
    ) {
      const users = new Set<string>();
      for (const entry of approvers) {
        // checkApproverEntry only keeps `user` entries whose value is an id or a list of ids.
        const ids = entry.value as string | string[];
        for (const id of typeof ids === 'string' ? [ids] : ids) users.add(id);
      }
      if (minimum > users.size) {
        this.report(
          'MINIMUM_EXCEEDS_APPROVERS',
          `${path}.mode.minimum`,
          scope,
          `mode.minimum (${minimum}) is greater than the ${users.size} unique user(s) listed as approvers.`,
        );
      }
    }
  }

  private checkChainNode(node: Obj, path: string, scope: NodeScope): void {
    this.checkUnknownFields(node, CHAIN_FIELDS, path, scope);

    if (!('chain' in node)) {
      this.report(
        'MISSING_CHAIN',
        `${path}.chain`,
        scope,
        'An approval-chain node needs "chain" (the name of a registered chain).',
      );
    } else if (this.checkString(node, 'chain', `${path}.chain`, scope, { nonEmpty: true })) {
      const chain = node.chain as string;
      if (this.chains && !this.chains.has(chain)) {
        this.report('UNKNOWN_CHAIN', `${path}.chain`, scope, `Chain "${chain}" is not registered.`);
      }
    }

    if ('from' in node) {
      const from = node.from;
      const valid =
        from === 'requester' ||
        (isObject(from) &&
          Object.keys(from).length === 1 &&
          typeof from.field === 'string' &&
          from.field !== '');
      if (!valid) {
        this.report(
          'INVALID_VALUE',
          `${path}.from`,
          scope,
          `"from" must be "requester" or { "field": "<path>" }, got ${describe(from)}.`,
        );
      }
    }
    if ('until' in node) this.checkApproverEntry(node.until, `${path}.until`, scope);
    this.checkBoolean(node, 'includeStopper', `${path}.includeStopper`, scope);
    if (!isPositiveInteger(node.maxLevels)) {
      const problem =
        'maxLevels' in node
          ? `got ${describe(node.maxLevels)}`
          : 'it is required as a safety limit';
      this.report(
        'INVALID_MAX_LEVELS',
        `${path}.maxLevels`,
        scope,
        `"maxLevels" must be an integer >= 1; ${problem}.`,
      );
    }
    this.checkEnum(
      node,
      'duplicateApprover',
      ['require', 'auto-approve'],
      `${path}.duplicateApprover`,
      scope,
    );
    this.checkBoolean(node, 'excludeRequester', `${path}.excludeRequester`, scope);
    this.checkEnum(
      node,
      'onEmptyApprovers',
      ['error', 'skip', 'fallback'],
      `${path}.onEmptyApprovers`,
      scope,
    );
    this.checkFallback(node, path, scope);
    this.checkTimeout(node, path, scope);
    this.checkReference(node, 'next', path, scope);
    this.checkReference(node, 'onReject', path, scope);
  }

  private checkConditionNode(node: Obj, path: string, scope: NodeScope): void {
    this.checkUnknownFields(node, CONDITION_FIELDS, path, scope);

    const rules = node.rules;
    if (!('rules' in node)) {
      this.report(
        'EMPTY_RULES',
        `${path}.rules`,
        scope,
        'A condition node needs at least one rule.',
      );
    } else if (!Array.isArray(rules)) {
      this.report(
        'INVALID_TYPE',
        `${path}.rules`,
        scope,
        `"rules" must be an array, got ${describe(rules)}.`,
      );
    } else {
      if (rules.length === 0) {
        this.report(
          'EMPTY_RULES',
          `${path}.rules`,
          scope,
          'A condition node needs at least one rule.',
        );
      }
      rules.forEach((rule: unknown, index) => {
        const rulePath = `${path}.rules[${index}]`;
        if (!isObject(rule)) {
          this.report(
            'INVALID_TYPE',
            rulePath,
            scope,
            `Rule #${index + 1} must be an object, got ${describe(rule)}.`,
          );
          return;
        }
        this.checkUnknownFields(rule, RULE_FIELDS, rulePath, scope);
        this.checkString(rule, 'label', `${rulePath}.label`, scope);
        if (!('when' in rule)) {
          this.report(
            'MISSING_FIELD',
            `${rulePath}.when`,
            scope,
            `Rule #${index + 1} needs a "when" expression.`,
          );
        } else {
          for (const problem of validateExpression(rule.when, this.operators)) {
            const where = problem.path === '' ? '' : ` at ${problem.path}`;
            this.report(
              'INVALID_CONDITION',
              `${rulePath}.when${problem.path === '' ? '' : `.${problem.path}`}`,
              scope,
              `Rule #${index + 1} has an invalid condition${where}: ${problem.message}`,
            );
          }
        }
        this.checkReference(rule, 'next', rulePath, scope, node);
      });
    }

    if (!('else' in node)) {
      this.report(
        'CONDITION_MISSING_ELSE',
        `${path}.else`,
        scope,
        'A condition node needs "else" for when no rule matches.',
      );
    } else {
      this.checkReference(node, 'else', path, scope);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Approvers
  // ---------------------------------------------------------------------------------------

  /** Validates an approver list and returns its well-formed entries. */
  private checkApproverList(
    target: Obj,
    key: string,
    path: string,
    scope: Scope,
    required: boolean,
  ): Obj[] {
    const fieldPath = `${path}.${key}`;
    if (!(key in target)) {
      if (required) this.report('MISSING_FIELD', fieldPath, scope, `"${key}" is required.`);
      return [];
    }
    const value = target[key];
    if (!Array.isArray(value)) {
      this.report(
        'INVALID_TYPE',
        fieldPath,
        scope,
        `"${key}" must be an array of approver entries, got ${describe(value)}.`,
      );
      return [];
    }
    if (value.length === 0) {
      this.report(
        'EMPTY_APPROVERS',
        fieldPath,
        scope,
        `"${key}" must contain at least one approver entry.`,
      );
    }
    const valid: Obj[] = [];
    value.forEach((entry: unknown, index) => {
      if (this.checkApproverEntry(entry, `${fieldPath}[${index}]`, scope)) valid.push(entry as Obj);
    });
    return valid;
  }

  private checkApproverEntry(entry: unknown, path: string, scope: Scope): boolean {
    if (!isObject(entry)) {
      this.report(
        'INVALID_TYPE',
        path,
        scope,
        `An approver entry must be an object like { "type": "role", ... }, got ${describe(entry)}.`,
      );
      return false;
    }
    if (!('type' in entry)) {
      this.report('MISSING_FIELD', `${path}.type`, scope, 'An approver entry needs "type".');
      return false;
    }
    const type = entry.type;
    if (typeof type !== 'string' || type === '') {
      this.report(
        'INVALID_TYPE',
        `${path}.type`,
        scope,
        `Approver "type" must be a non-empty string, got ${describe(type)}.`,
      );
      return false;
    }
    if (this.approverTypes && !this.approverTypes.has(type)) {
      this.report(
        'UNKNOWN_APPROVER_TYPE',
        `${path}.type`,
        scope,
        `Approver type "${type}" is not registered.`,
      );
      return false;
    }

    if (type === 'user' || type === 'field') {
      this.checkUnknownFields(entry, ['type', 'value'], path, scope);
      const value = entry.value;
      const valid =
        type === 'user'
          ? (typeof value === 'string' && value !== '') ||
            (Array.isArray(value) &&
              value.length > 0 &&
              value.every((id) => typeof id === 'string' && id !== ''))
          : typeof value === 'string' && value !== '';
      if (!valid) {
        const expected =
          type === 'user'
            ? 'a user id or a non-empty array of user ids'
            : 'a document field path such as "pic_user_id"';
        this.report(
          'INVALID_APPROVER_CONFIG',
          `${path}.value`,
          scope,
          `Approver type "${type}" needs "value" to be ${expected}, got ${describe(value)}.`,
        );
        return false;
      }
    }
    return true;
  }

  private checkFallback(target: Obj, path: string, scope: Scope): void {
    const needsFallback =
      target.onEmptyApprovers === 'fallback' || target.onInsufficientApprovers === 'fallback';
    if (needsFallback && !('fallbackApprovers' in target)) {
      const policy =
        target.onEmptyApprovers === 'fallback' ? 'onEmptyApprovers' : 'onInsufficientApprovers';
      this.report(
        'MISSING_FALLBACK_APPROVERS',
        `${path}.fallbackApprovers`,
        scope,
        `"${policy}": "fallback" requires "fallbackApprovers".`,
      );
      return;
    }
    this.checkApproverList(target, 'fallbackApprovers', path, scope, false);
  }

  private checkTimeout(node: Obj, path: string, scope: Scope): void {
    if (!('timeout' in node)) return;
    const timeout = node.timeout;
    const timeoutPath = `${path}.timeout`;
    if (!isObject(timeout)) {
      this.report(
        'INVALID_TYPE',
        timeoutPath,
        scope,
        `"timeout" must be an object, got ${describe(timeout)}.`,
      );
      return;
    }
    this.checkUnknownFields(timeout, TIMEOUT_FIELDS, timeoutPath, scope);
    if (!('after' in timeout)) {
      this.report(
        'MISSING_FIELD',
        `${timeoutPath}.after`,
        scope,
        '"timeout.after" is required, e.g. "P3D".',
      );
    } else if (typeof timeout.after !== 'string' || parseDuration(timeout.after) === null) {
      this.report(
        'INVALID_DURATION',
        `${timeoutPath}.after`,
        scope,
        `"timeout.after" must be an ISO 8601 duration such as "P3D" or "PT12H", got ${describe(timeout.after)}.`,
      );
    }
    if (!('action' in timeout)) {
      this.report(
        'MISSING_FIELD',
        `${timeoutPath}.action`,
        scope,
        '"timeout.action" is required ("escalate").',
      );
    } else {
      this.checkEnum(timeout, 'action', ['escalate'], `${timeoutPath}.action`, scope);
    }
    this.checkApproverList(timeout, 'to', timeoutPath, scope, true);
  }

  // ---------------------------------------------------------------------------------------
  // Graph
  // ---------------------------------------------------------------------------------------

  /**
   * Validates a node reference. A missing exit is a dead end, except `else` which has its own
   * code (reported by the caller).
   *
   * @param owner the node that owns the edge when `target` is a nested object (a rule).
   */
  private checkReference(
    target: Obj,
    key: string,
    path: string,
    scope: NodeScope,
    owner?: Obj,
  ): void {
    const fieldPath = `${path}.${key}`;
    if (!(key in target)) {
      const subject = owner ? 'This rule' : 'This node';
      this.report(
        'DEAD_END',
        fieldPath,
        scope,
        `${subject} has no "${key}"; every path must lead to an end node.`,
      );
      return;
    }
    const value = target[key];
    if (typeof value !== 'string') {
      this.report(
        'INVALID_TYPE',
        fieldPath,
        scope,
        `"${key}" must be a node id, got ${describe(value)}.`,
      );
      return;
    }
    if (!this.nodeIds.has(value)) {
      this.report(
        'UNKNOWN_NODE_REFERENCE',
        fieldPath,
        scope,
        `"${key}" points to node "${value}", which does not exist.`,
      );
      return;
    }
    const targets = this.edges.get(scope.nodeId) ?? [];
    targets.push(value);
    this.edges.set(scope.nodeId, targets);
  }

  private checkGraph(flow: Obj, nodes: Obj): void {
    let startValid = false;
    if (!('start' in flow)) {
      this.report('MISSING_FIELD', 'start', {}, '"start" is required.');
    } else if (typeof flow.start !== 'string') {
      this.report(
        'INVALID_TYPE',
        'start',
        {},
        `"start" must be a node id, got ${describe(flow.start)}.`,
      );
    } else if (!this.nodeIds.has(flow.start)) {
      this.report(
        'UNKNOWN_NODE_REFERENCE',
        'start',
        {},
        `"start" points to node "${flow.start}", which does not exist.`,
      );
    } else {
      startValid = true;
    }

    const hasEnd = Object.values(nodes).some((node) => isObject(node) && node.type === 'end');
    if (this.nodeIds.size > 0 && !hasEnd) {
      this.report('NO_END_NODE', 'nodes', {}, 'A flow needs at least one node of type "end".');
    }

    if (startValid) {
      const reached = new Set<string>([flow.start as string]);
      const queue = [flow.start as string];
      for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
        for (const next of this.edges.get(current) ?? []) {
          if (!reached.has(next)) {
            reached.add(next);
            queue.push(next);
          }
        }
      }
      for (const nodeId of this.nodeIds) {
        if (!reached.has(nodeId)) {
          this.report(
            'UNREACHABLE_NODE',
            `nodes.${nodeId}`,
            { nodeId },
            `Node "${nodeId}" cannot be reached from "start".`,
          );
        }
      }
    }

    this.checkCycles();
  }

  /** Reports each loop once, at the node where the loop closes. */
  private checkCycles(): void {
    const done = new Set<string>();
    const stack: string[] = [];
    const onStack = new Set<string>();

    const visit = (nodeId: string): void => {
      stack.push(nodeId);
      onStack.add(nodeId);
      for (const next of new Set(this.edges.get(nodeId) ?? [])) {
        if (onStack.has(next)) {
          const loop = [...stack.slice(stack.indexOf(next)), next].join(' → ');
          this.report(
            'CYCLE',
            `nodes.${nodeId}`,
            { nodeId },
            `Loop detected: ${loop}. Flows cannot loop; use returnForRevision to send a document back.`,
          );
        } else if (!done.has(next)) {
          visit(next);
        }
      }
      stack.pop();
      onStack.delete(nodeId);
      done.add(nodeId);
    };

    for (const nodeId of this.nodeIds) {
      if (!done.has(nodeId)) visit(nodeId);
    }
  }

  private checkVariables(variables: unknown): void {
    if (!Array.isArray(variables)) {
      this.report(
        'INVALID_TYPE',
        'variables',
        {},
        `"variables" must be an array, got ${describe(variables)}.`,
      );
      return;
    }
    const keys = new Set<string>();
    variables.forEach((variable: unknown, index) => {
      const path = `variables[${index}]`;
      if (!isObject(variable)) {
        this.report(
          'INVALID_TYPE',
          path,
          {},
          `Variable #${index + 1} must be an object, got ${describe(variable)}.`,
        );
        return;
      }
      this.checkUnknownFields(variable, VARIABLE_FIELDS, path, {});
      if (this.checkString(variable, 'key', `${path}.key`, {}, { required: true })) {
        const key = variable.key as string;
        if (!VARIABLE_KEY_REGEX.test(key)) {
          this.report(
            'INVALID_VARIABLE_KEY',
            `${path}.key`,
            {},
            `Variable key "${key}" must be a path such as "amount" or "pic.user_id".`,
          );
        } else if (keys.has(key)) {
          this.report(
            'DUPLICATE_VARIABLE',
            `${path}.key`,
            {},
            `Variable "${key}" is declared more than once.`,
          );
        }
        keys.add(key);
      }
      this.checkString(variable, 'label', `${path}.label`, {});
      if (!('type' in variable)) {
        this.report('MISSING_FIELD', `${path}.type`, {}, `Variable #${index + 1} needs a "type".`);
      } else {
        this.checkEnum(variable, 'type', VARIABLE_TYPES, `${path}.type`, {});
      }
      this.checkBoolean(variable, 'required', `${path}.required`, {});

      const options = variable.options;
      if (variable.type === 'select') {
        const valid =
          Array.isArray(options) &&
          options.length > 0 &&
          options.every((option) => typeof option === 'string' && option !== '') &&
          new Set(options).size === options.length;
        if (!valid) {
          this.report(
            'INVALID_OPTIONS',
            `${path}.options`,
            {},
            `A "select" variable needs "options": a non-empty list of distinct, non-empty strings.`,
          );
        }
      } else if ('options' in variable) {
        this.report(
          'INVALID_OPTIONS',
          `${path}.options`,
          {},
          `"options" only apply to "select" variables.`,
        );
      }
    });
  }

  private checkLayout(layout: unknown): void {
    if (!isObject(layout)) {
      this.report(
        'INVALID_TYPE',
        'layout',
        {},
        `"layout" must be an object keyed by node id, got ${describe(layout)}.`,
      );
      return;
    }
    for (const [nodeId, position] of Object.entries(layout)) {
      const path = `layout.${nodeId}`;
      if (!isObject(position)) {
        this.report(
          'INVALID_TYPE',
          path,
          { nodeId },
          `Position must be an object like { "x": 0, "y": 0 }, got ${describe(position)}.`,
        );
        continue;
      }
      this.checkUnknownFields(position, ['x', 'y'], path, { nodeId });
      for (const axis of ['x', 'y']) {
        const value = position[axis];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          this.report(
            'INVALID_TYPE',
            `${path}.${axis}`,
            { nodeId },
            `"${axis}" must be a finite number, got ${describe(value)}.`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------------------------

  private report(code: FlowValidationCode, path: string, scope: Scope, message: string): void {
    const where =
      scope.nodeId === undefined
        ? 'Flow'
        : scope.groupId === undefined
          ? `Node "${scope.nodeId}"`
          : `Node "${scope.nodeId}", group "${scope.groupId}"`;
    const issue: FlowValidationIssue = { code, message: `${where}: ${message}`, path };
    if (scope.nodeId !== undefined) issue.nodeId = scope.nodeId;
    if (scope.groupId !== undefined) issue.groupId = scope.groupId;
    this.issues.push(issue);
  }

  private checkUnknownFields(
    target: Obj,
    allowed: readonly string[],
    path: string,
    scope: Scope,
  ): void {
    for (const key of Object.keys(target)) {
      if (!allowed.includes(key)) {
        const fieldPath = path === '' ? key : `${path}.${key}`;
        this.report(
          'UNKNOWN_FIELD',
          fieldPath,
          scope,
          `Unknown field "${key}"; allowed fields are ${list(allowed)}.`,
        );
      }
    }
  }

  /** Returns `true` when the field is present and a string (non-empty when requested). */
  private checkString(
    target: Obj,
    key: string,
    path: string,
    scope: Scope,
    { required = false, nonEmpty = required }: { required?: boolean; nonEmpty?: boolean } = {},
  ): boolean {
    if (!(key in target)) {
      if (required) this.report('MISSING_FIELD', path, scope, `"${key}" is required.`);
      return false;
    }
    const value = target[key];
    if (typeof value !== 'string') {
      this.report(
        'INVALID_TYPE',
        path,
        scope,
        `"${key}" must be a string, got ${describe(value)}.`,
      );
      return false;
    }
    if (nonEmpty && value === '') {
      this.report('INVALID_VALUE', path, scope, `"${key}" must not be empty.`);
      return false;
    }
    return true;
  }

  /** Returns `true` when the field is a valid slug. */
  private checkSlug(target: Obj, key: string, path: string, scope: Scope, what: string): boolean {
    if (!this.checkString(target, key, path, scope, { required: true })) return false;
    const value = target[key] as string;
    if (!SLUG_REGEX.test(value)) {
      this.report(
        'INVALID_ID',
        path,
        scope,
        `${what} "${value}" must be a slug (letters, digits, "_" and "-", max 100 characters).`,
      );
      return false;
    }
    return true;
  }

  private checkBoolean(target: Obj, key: string, path: string, scope: Scope): void {
    if (key in target && typeof target[key] !== 'boolean') {
      this.report(
        'INVALID_TYPE',
        path,
        scope,
        `"${key}" must be true or false, got ${describe(target[key])}.`,
      );
    }
  }

  private checkEnum(
    target: Obj,
    key: string,
    allowed: readonly string[],
    path: string,
    scope: Scope,
  ): void {
    if (!(key in target)) return;
    const value = target[key];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.report(
        'INVALID_VALUE',
        path,
        scope,
        `"${key}" must be one of ${list(allowed)}, got ${describe(value)}.`,
      );
    }
  }

  /** Checks `{ minimum: n }` and returns `n` when it is valid. */
  private checkMinimumObject(
    target: Obj,
    path: string,
    scope: Scope,
    code: FlowValidationCode,
    label: string,
  ): number | undefined {
    this.checkUnknownFields(target, ['minimum'], path, scope);
    const minimum = target.minimum;
    if (!isPositiveInteger(minimum)) {
      this.report(
        code,
        `${path}.minimum`,
        scope,
        `${label} must be an integer >= 1, got ${describe(minimum)}.`,
      );
      return undefined;
    }
    return minimum;
  }
}
