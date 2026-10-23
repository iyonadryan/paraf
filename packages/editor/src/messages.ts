import type { DocumentVariableType, FlowNodeType } from '@paraf/core';

/**
 * Every text the editor and the progress view show. Pass a partial object as `messages` to
 * translate or reword it; missing keys fall back to {@link defaultMessages}.
 */
export interface Messages {
  nodeTypes: Record<FlowNodeType, string>;
  nodeTypeHints: Record<FlowNodeType, string>;
  /** Base of generated node IDs, per node type (e.g. `approval_1`). */
  nodeIdBases: Record<FlowNodeType, string>;
  /** Label of a node created from the palette. */
  newNodeLabels: Record<FlowNodeType, string>;

  // Header
  undo: string;
  redo: string;
  importJson: string;
  exportJson: string;
  importFailed: (reason: string) => string;
  publish: string;
  publishVersion: (version: number) => string;
  draftNeverPublished: string;
  draftVersion: (version: number) => string;
  activeVersion: (version: number) => string;
  fixBeforePublishing: (count: number) => string;

  // Palette
  palette: string;
  waysToAdd: string;
  waysToAddTips: string[];
  registeredTypes: string;

  // Canvas
  start: string;
  addNext: string;
  addAfter: (label: string) => string;
  zoomIn: string;
  zoomOut: string;
  tidyUp: string;
  fitView: string;
  edgeReject: string;
  edgeElse: string;

  // Node summaries
  modeAny: string;
  modeAll: string;
  modeMinimum: (minimum: number) => string;
  parallelGroups: (count: number) => string;
  requireAll: string;
  requireAny: string;
  requireMinimum: (minimum: number) => string;
  noApprovers: string;
  timeoutSummary: (duration: string) => string;
  durationUnits: {
    years: string;
    months: string;
    weeks: string;
    days: string;
    hours: string;
    minutes: string;
    seconds: string;
  };
  chainSummary: (chain: string) => string;
  chainUntil: (until: string) => string;
  maxLevelsSummary: (levels: number) => string;
  duplicatesAuto: string;
  endApproved: string;
  endRejected: string;

  // Empty state
  emptyTitle: string;
  emptyText: string;
  emptySteps: string[];
  templatesTitle: string;
  templates: { single: [string, string]; multi: [string, string]; amount: [string, string] };

  // Panel: shared
  flowSettings: string;
  flowName: string;
  flowId: string;
  flowIdHint: (id: string) => string;
  startNode: string;
  nodeKind: (type: string) => string;
  nodeId: string;
  nodeIdInvalid: string;
  nodeIdTaken: string;
  label: string;
  setAsStart: string;
  deleteNode: string;
  defaultOption: (value: string) => string;
  none: string;
  yes: string;
  no: string;
  remove: string;
  moveUp: string;
  moveDown: string;
  cancel: string;
  save: string;
  advanced: string;
  connections: string;
  next: string;
  onReject: string;

  // Panel: approvals
  approvers: string;
  approverGroups: string;
  groupCount: (count: number) => string;
  splitIntoGroups: string;
  mergeGroups: string;
  howManyApprove: string;
  modeAnyButton: string;
  modeAllButton: string;
  modeMinimumButton: string;
  minimumN: string;
  addSource: string;
  sourcesHint: string;
  chooseSource: string;
  searchOptions: string;
  listHint: string;
  unknownApproverType: string;
  noVariableOptions: string;
  nodeCompletesWhen: string;
  requireOptions: { all: string; any: string; minimum: string };
  groupLabel: string;
  groupId: string;
  addGroup: string;
  rejectPolicy: string;
  rejectPolicies: { any: string; impossible: string; minimum: string };
  rejectMinimum: string;
  onEmptyApprovers: string;
  emptyPolicies: { error: string; skip: string; fallback: string };
  onInsufficientApprovers: string;
  insufficientPolicies: { error: string; cap: string; fallback: string };
  fallbackApprovers: string;
  countAcrossGroups: [string, string];
  excludeRequester: [string, string];
  duplicateApprover: string;
  duplicatePolicies: { require: string; 'auto-approve': string };
  timeout: string;
  timeoutAfter: string;
  timeoutAfterHint: string;
  escalateTo: string;
  incompleteNode: string;

  // Panel: approval chains
  reportingLine: string;
  chain: string;
  from: string;
  fromRequester: string;
  fromField: string;
  fieldPath: string;
  until: string;
  addUntil: string;
  includeStopper: [string, string];
  maxLevels: string;
  onEmptyChain: string;

  // Panel: conditions
  rules: string;
  rulesOrder: string;
  rule: (index: number) => string;
  ruleName: string;
  if: string;
  and: string;
  or: string;
  addComparison: string;
  goTo: string;
  addRule: string;
  otherwise: string;
  viewJson: string;
  operator: string;
  value: string;
  operators: Record<'==' | '!=' | '>' | '>=' | '<' | '<=' | 'in', string>;
  chooseField: string;
  documentVariables: string;
  customField: string;
  customFieldPlaceholder: string;
  valueTypes: { text: string; number: string; boolean: string; list: string };
  alwaysTrue: string;
  advancedExpression: string;
  replaceWithBuilder: string;

  // Panel: end
  result: string;
  resultApproved: string;
  resultRejected: string;

  // Flow settings: resubmit and variables
  resubmitPolicy: string;
  resubmitPolicies: { restart: string; resume: string };
  variablesTitle: string;
  variableCount: (count: number) => string;
  variablesHint: string;
  addVariable: string;
  editVariable: string;
  variableKey: string;
  variableType: string;
  variableTypes: Record<DocumentVariableType, string>;
  variableOptions: string;
  addOption: string;
  variableRequired: string;
  variableRequiredShort: string;
  variableKeyInvalid: string;
  variableKeyTaken: string;

  // Status bar and problems
  flowValid: string;
  problemCount: (count: number) => string;
  counts: (nodes: number, connections: number) => string;
  problems: string;
  problemsHint: string;
  show: string;

  // Publish dialog
  publishTitle: (version: number) => string;
  runningInstances: (count: number, version: number) => string;
  changesSince: (version: number) => string;
  firstVersion: string;
  noChanges: string;
  changeKinds: { added: string; changed: string; removed: string };
  changeText: {
    nodeAdded: (label: string, type: string) => string;
    nodeRemoved: (label: string) => string;
    nodeChanged: (label: string, fields: string) => string;
    flowChanged: (fields: string) => string;
  };
  releaseNotes: string;
  validationPassed: string;
  publishFailed: (reason: string) => string;

  // Progress view
  legend: string;
  statusDone: string;
  statusActive: string;
  statusRejected: string;
  statusNotReached: string;
  submitted: string;
  readOnlyVersion: (version: number) => string;
  instanceStatus: Record<
    'pending' | 'in_progress' | 'returned' | 'approved' | 'rejected' | 'cancelled',
    string
  >;
  requester: string;
  due: string;
  history: string;
  level: (level: number) => string;
  groupProgress: (approved: number, required: number) => string;
  notStarted: string;
  auditActions: Record<string, string>;
}

const durationUnits = {
  years: 'year',
  months: 'month',
  weeks: 'week',
  days: 'day',
  hours: 'hour',
  minutes: 'minute',
  seconds: 'second',
};

/** English texts, used for every key not overridden through `messages`. */
export const defaultMessages: Messages = {
  nodeTypes: {
    approval: 'Approval',
    'approval-chain': 'Approval chain',
    condition: 'Condition',
    end: 'End',
  },
  nodeTypeHints: {
    approval: 'One level, one or more groups',
    'approval-chain': 'Walk up the reporting line until a condition is met',
    condition: 'Branch on document data',
    end: 'Final result: approved or rejected',
  },
  nodeIdBases: {
    approval: 'approval',
    'approval-chain': 'chain',
    condition: 'condition',
    end: 'end',
  },
  newNodeLabels: {
    approval: 'New approval',
    'approval-chain': 'New approval chain',
    condition: 'New condition',
    end: 'End',
  },

  undo: 'Undo',
  redo: 'Redo',
  importJson: 'Import',
  exportJson: 'Export JSON',
  importFailed: (reason) => `Import failed: ${reason}`,
  publish: 'Publish',
  publishVersion: (version) => `Publish v${version}`,
  draftNeverPublished: 'draft · never published',
  draftVersion: (version) => `v${version} · draft`,
  activeVersion: (version) => `active: v${version}`,
  fixBeforePublishing: (count) => `Fix ${count} problem${count === 1 ? '' : 's'} before publishing`,

  palette: 'Nodes',
  waysToAdd: 'Ways to add',
  waysToAddTips: [
    'Drag a node from here onto the canvas',
    'Click + below a node to add the next one, already connected',
    "Drag from a node's handle to another node to connect them",
  ],
  registeredTypes: 'Registered approver types',

  start: 'Start',
  addNext: 'Add next node',
  addAfter: (label) => `Add after "${label}"`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  tidyUp: 'Tidy up',
  fitView: 'Fit view',
  edgeReject: 'reject',
  edgeElse: 'else',

  modeAny: 'any 1',
  modeAll: 'all',
  modeMinimum: (minimum) => `at least ${minimum}`,
  parallelGroups: (count) => `${count} parallel group${count === 1 ? '' : 's'}`,
  requireAll: 'All groups must be satisfied',
  requireAny: 'Any one group is enough',
  requireMinimum: (minimum) => `At least ${minimum} groups must be satisfied`,
  noApprovers: 'No approvers yet',
  timeoutSummary: (duration) => `Timeout ${duration} → escalate`,
  durationUnits,
  chainSummary: (chain) => `${chain} line`,
  chainUntil: (until) => `stops at ${until}`,
  maxLevelsSummary: (levels) => `Max ${levels} levels`,
  duplicatesAuto: 'duplicates: auto-approve',
  endApproved: 'Approved',
  endRejected: 'Rejected',

  emptyTitle: 'This flow is empty',
  emptyText:
    'Drag a node from the left panel onto the canvas, click + below Start, or begin from a template.',
  emptySteps: [
    'Fill in flow details',
    'Add document variables (amount, department, ...)',
    'Add nodes and set approvers',
    'Connect every path to an End',
    'Validate, then publish',
  ],
  templatesTitle: 'Start from a template',
  templates: {
    single: ['Single level', 'One approval'],
    multi: ['Multi-level', 'Two levels in a row'],
    amount: ['By amount', 'Branch on a number'],
  },

  flowSettings: 'Flow settings',
  flowName: 'Flow name',
  flowId: 'Flow ID',
  flowIdHint: (id) => `Used in code: engine.start('${id}', ...)`,
  startNode: 'Start node',
  nodeKind: (type) => `${type} node`,
  nodeId: 'Node ID',
  nodeIdInvalid: 'Use letters, digits, "_" and "-".',
  nodeIdTaken: 'Another node already uses this ID.',
  label: 'Label',
  setAsStart: 'Set as start',
  deleteNode: 'Delete node',
  defaultOption: (value) => `${value} (default)`,
  none: '—',
  yes: 'Yes',
  no: 'No',
  remove: 'Remove',
  moveUp: 'Move up',
  moveDown: 'Move down',
  cancel: 'Cancel',
  save: 'Save',
  advanced: 'Advanced',
  connections: 'Connections',
  next: 'Then go to',
  onReject: 'If rejected, go to',

  approvers: 'Approvers',
  approverGroups: 'Approver groups',
  groupCount: (count) => `${count} group${count === 1 ? '' : 's'}`,
  splitIntoGroups: 'Split into parallel groups',
  mergeGroups: 'Merge into one group',
  howManyApprove: 'How many must approve',
  modeAnyButton: 'Any 1',
  modeAllButton: 'All',
  modeMinimumButton: 'At least n',
  minimumN: 'n',
  addSource: '+ Add approver source',
  sourcesHint:
    'Choose who approves at this step: by role, group, manager, specific users, or from a document variable.',
  chooseSource: 'Choose an approver source',
  searchOptions: 'Search',
  listHint: 'Separate several values with commas.',
  unknownApproverType: 'This approver type is not registered; its settings are kept as they are.',
  noVariableOptions: 'Add a document variable of type User to pick it here.',
  nodeCompletesWhen: 'Node completes when',
  requireOptions: {
    all: 'All groups are satisfied',
    any: 'Any one group is satisfied',
    minimum: 'At least n groups are satisfied',
  },
  groupLabel: 'Group name',
  groupId: 'Group ID',
  addGroup: '+ Add group',
  rejectPolicy: 'Rejected when',
  rejectPolicies: {
    any: 'Anyone rejects',
    impossible: 'The minimum can no longer be reached',
    minimum: 'n people reject',
  },
  rejectMinimum: 'Rejections',
  onEmptyApprovers: 'If nobody is found',
  emptyPolicies: { error: 'Error', skip: 'Skip this step', fallback: 'Use fallback approvers' },
  onInsufficientApprovers: 'If there are fewer than n approvers',
  insufficientPolicies: {
    error: 'Error',
    cap: 'Lower the minimum (cap)',
    fallback: 'Add fallback approvers',
  },
  fallbackApprovers: 'Fallback approvers',
  countAcrossGroups: ['Count votes in every group', 'For users who hold two roles'],
  excludeRequester: ['Exclude the requester', "Requesters can't approve their own request"],
  duplicateApprover: 'Approvers who already approved at an earlier level',
  duplicatePolicies: { require: 'Must approve again', 'auto-approve': 'Auto-approve' },
  timeout: 'Escalate after a timeout',
  timeoutAfter: 'After',
  timeoutAfterHint: 'ISO 8601 duration, e.g. P3D (3 days) or PT12H (12 hours).',
  escalateTo: 'Escalate to',
  incompleteNode: 'Incomplete',

  reportingLine: 'Reporting line',
  chain: 'Chain',
  from: 'Start from',
  fromRequester: 'The requester',
  fromField: 'A user in a document variable',
  fieldPath: 'Variable',
  until: 'Stop at',
  addUntil: '+ Add a stop condition',
  includeStopper: ['That person approves too', 'Otherwise the chain stops just below them'],
  maxLevels: 'Maximum levels',
  onEmptyChain: 'If there is nobody above',

  rules: 'Rules',
  rulesOrder: 'checked top to bottom',
  rule: (index) => `Rule ${index + 1}`,
  ruleName: 'Name (optional)',
  if: 'If',
  and: 'and',
  or: 'or',
  addComparison: '+ Add condition (AND / OR)',
  goTo: 'Go to',
  addRule: '+ Add rule',
  otherwise: 'Otherwise (required)',
  viewJson: 'View as JSON',
  operator: 'Operator',
  value: 'Value',
  operators: {
    '==': 'equals',
    '!=': 'does not equal',
    '>': 'is greater than',
    '>=': 'is at least',
    '<': 'is less than',
    '<=': 'is at most',
    in: 'is one of',
  },
  chooseField: 'Choose a variable',
  documentVariables: 'Document variables',
  customField: 'Other field',
  customFieldPlaceholder: 'path, e.g. items.0.price',
  valueTypes: { text: 'Text', number: 'Number', boolean: 'Yes/No', list: 'List' },
  alwaysTrue: 'Always matches. Add a condition to narrow it down.',
  advancedExpression: 'This expression is too complex for the builder; it is kept as it is.',
  replaceWithBuilder: 'Replace with a simple rule',

  result: 'Result',
  resultApproved: 'Approved',
  resultRejected: 'Rejected',

  resubmitPolicy: 'When a returned document is resubmitted',
  resubmitPolicies: {
    restart: 'Restart from the beginning',
    resume: 'Resume from the step that returned it',
  },
  variablesTitle: 'Document variables',
  variableCount: (count) => `${count} variable${count === 1 ? '' : 's'}`,
  variablesHint:
    "Variables are document data your app sends on submission, such as the amount or department. They're used in conditions and approvers.",
  addVariable: '+ Add variable',
  editVariable: 'Edit variable',
  variableKey: 'Key',
  variableType: 'Type',
  variableTypes: {
    number: 'Number',
    text: 'Text',
    select: 'Select',
    date: 'Date',
    boolean: 'Yes/No',
    user: 'User',
  },
  variableOptions: 'Options',
  addOption: '+ option',
  variableRequired: 'Required on submission',
  variableRequiredShort: 'Required',
  variableKeyInvalid: 'Use a path such as amount or pic.user_id.',
  variableKeyTaken: 'Another variable already uses this key.',

  flowValid: 'Flow is valid',
  problemCount: (count) => `${count} problem${count === 1 ? '' : 's'}`,
  counts: (nodes, connections) =>
    `${nodes} node${nodes === 1 ? '' : 's'} · ${connections} connection${connections === 1 ? '' : 's'}`,
  problems: 'Problems',
  problemsHint: 'Checked on every change, using the same validateFlow() as the engine.',
  show: 'Show',

  publishTitle: (version) => `Publish version ${version}`,
  runningInstances: (count, version) =>
    `${count} document${count === 1 ? '' : 's'} in progress keep using v${version} until they finish. Only new submissions use the new version.`,
  changesSince: (version) => `Changes since v${version}`,
  firstVersion: 'This is the first version of the flow.',
  noChanges: 'No changes.',
  changeKinds: { added: 'added', changed: 'changed', removed: 'removed' },
  changeText: {
    nodeAdded: (label, type) => `Node ${label} (${type})`,
    nodeRemoved: (label) => `Node ${label}`,
    nodeChanged: (label, fields) => `${label}: ${fields}`,
    flowChanged: (fields) => `Flow: ${fields}`,
  },
  releaseNotes: 'Release notes',
  validationPassed: 'Validation passed',
  publishFailed: (reason) => `Publishing failed: ${reason}`,

  legend: 'Legend',
  statusDone: 'Done',
  statusActive: 'Awaiting decision',
  statusRejected: 'Rejected',
  statusNotReached: 'Not reached yet',
  submitted: 'Submitted',
  readOnlyVersion: (version) => `Read-only · flow v${version}`,
  instanceStatus: {
    pending: 'Pending',
    in_progress: 'In progress',
    returned: 'Returned for revision',
    approved: 'Approved',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
  },
  requester: 'Requester',
  due: 'Due',
  history: 'History',
  level: (level) => `Lv ${level}`,
  groupProgress: (approved, required) => `${approved} / ${required}`,
  notStarted: 'Not started',
  auditActions: {
    started: 'submitted',
    approved: 'approved',
    auto_approved: 'auto-approved',
    rejected: 'rejected',
    delegated: 'delegated',
    returned: 'returned for revision',
    resubmitted: 'resubmitted',
    escalated: 'escalated',
    reresolved: 're-resolved approvers',
    skipped: 'skipped',
    condition_evaluated: 'evaluated a condition',
    chain_completed: 'finished the chain',
    cancelled: 'cancelled',
    completed: 'completed',
    step_entered: 'entered a step',
    step_failed: 'could not enter a step',
  },
};

/** Merges overrides into the default messages (one level deep). */
export function resolveMessages(overrides: Partial<Messages> = {}): Messages {
  return { ...defaultMessages, ...overrides };
}
