import { DURATION_PATTERN } from '../duration';
import type { JsonObject } from '../types/json';
import { SLUG_PATTERN, VARIABLE_KEY_PATTERN } from '../validation/validate-flow';

const ref = (name: string): JsonObject => ({ $ref: `#/$defs/${name}` });

const minimumObject = (description: string): JsonObject => ({
  type: 'object',
  description,
  properties: { minimum: { type: 'integer', minimum: 1 } },
  required: ['minimum'],
  additionalProperties: false,
});

const groupRuleProperties: JsonObject = {
  approvers: ref('approverList'),
  mode: ref('mode'),
  rejectPolicy: ref('rejectPolicy'),
  excludeRequester: { type: 'boolean', default: false },
  onEmptyApprovers: { enum: ['error', 'skip', 'fallback'], default: 'error' },
  onInsufficientApprovers: { enum: ['error', 'cap', 'fallback'], default: 'error' },
  fallbackApprovers: ref('approverList'),
};

const approvalBaseProperties: JsonObject = {
  type: { const: 'approval' },
  label: { type: 'string' },
  duplicateApprover: ref('duplicateApprover'),
  timeout: ref('timeout'),
  next: ref('nodeRef'),
  onReject: ref('nodeRef'),
};

/**
 * JSON Schema (draft 2020-12) of {@link FlowDefinition}. It checks the shape of a flow;
 * references between nodes, reachability, loops, and condition expressions are only checked by
 * `validateFlow`. Also published as `@paraf/core/flow.schema.json`.
 */
export const flowSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Paraf flow definition',
  type: 'object',
  required: ['id', 'name', 'start', 'nodes'],
  additionalProperties: false,
  properties: {
    id: ref('slug'),
    version: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1 },
    start: ref('nodeRef'),
    resubmitPolicy: { enum: ['restart', 'resume'], default: 'restart' },
    variables: { type: 'array', items: ref('variable') },
    nodes: {
      type: 'object',
      minProperties: 1,
      propertyNames: ref('slug'),
      additionalProperties: ref('node'),
    },
    layout: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['x', 'y'],
        additionalProperties: false,
        properties: { x: { type: 'number' }, y: { type: 'number' } },
      },
    },
  },
  $defs: {
    slug: { type: 'string', pattern: SLUG_PATTERN },
    nodeRef: { type: 'string', minLength: 1 },
    duration: { type: 'string', pattern: DURATION_PATTERN },
    variable: {
      type: 'object',
      required: ['key', 'type'],
      additionalProperties: false,
      properties: {
        key: { type: 'string', pattern: VARIABLE_KEY_PATTERN },
        label: { type: 'string' },
        type: { enum: ['number', 'text', 'select', 'date', 'boolean', 'user'] },
        options: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
        required: { type: 'boolean', default: false },
      },
      if: { properties: { type: { const: 'select' } } },
      then: { required: ['options'], properties: { options: true } },
      else: { not: { required: ['options'], properties: { options: true } } },
    },
    approverEntry: {
      type: 'object',
      required: ['type'],
      properties: { type: { type: 'string', minLength: 1 } },
      allOf: [
        {
          if: { properties: { type: { const: 'user' } } },
          then: {
            additionalProperties: false,
            required: ['value'],
            properties: {
              type: true,
              value: {
                oneOf: [
                  { type: 'string', minLength: 1 },
                  { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
                ],
              },
            },
          },
        },
        {
          if: { properties: { type: { const: 'field' } } },
          then: {
            additionalProperties: false,
            required: ['value'],
            properties: { type: true, value: { type: 'string', minLength: 1 } },
          },
        },
      ],
    },
    approverList: { type: 'array', minItems: 1, items: ref('approverEntry') },
    mode: {
      oneOf: [{ enum: ['any', 'all'] }, minimumObject('At least n approvals.')],
    },
    rejectPolicy: {
      oneOf: [{ enum: ['any', 'impossible'] }, minimumObject('Rejected after n rejections.')],
    },
    require: {
      oneOf: [{ enum: ['all', 'any'] }, minimumObject('At least n groups satisfied.')],
      default: 'all',
    },
    duplicateApprover: { enum: ['require', 'auto-approve'], default: 'require' },
    timeout: {
      type: 'object',
      required: ['after', 'action', 'to'],
      additionalProperties: false,
      properties: {
        after: ref('duration'),
        action: { const: 'escalate' },
        to: ref('approverList'),
      },
    },
    group: {
      type: 'object',
      required: ['id', 'approvers', 'mode'],
      additionalProperties: false,
      properties: { id: ref('slug'), label: { type: 'string' }, ...groupRuleProperties },
    },
    singleGroupApprovalNode: {
      type: 'object',
      required: ['type', 'approvers', 'mode', 'next', 'onReject'],
      additionalProperties: false,
      properties: { ...approvalBaseProperties, ...groupRuleProperties },
    },
    multiGroupApprovalNode: {
      type: 'object',
      required: ['type', 'groups', 'next', 'onReject'],
      additionalProperties: false,
      properties: {
        ...approvalBaseProperties,
        groups: { type: 'array', minItems: 1, items: ref('group') },
        require: ref('require'),
        countAcrossGroups: { type: 'boolean', default: true },
      },
    },
    approvalChainNode: {
      type: 'object',
      required: ['type', 'chain', 'maxLevels', 'next', 'onReject'],
      additionalProperties: false,
      properties: {
        type: { const: 'approval-chain' },
        label: { type: 'string' },
        chain: { type: 'string', minLength: 1 },
        from: {
          default: 'requester',
          oneOf: [
            { const: 'requester' },
            {
              type: 'object',
              required: ['field'],
              additionalProperties: false,
              properties: { field: { type: 'string', minLength: 1 } },
            },
          ],
        },
        until: ref('approverEntry'),
        includeStopper: { type: 'boolean', default: true },
        maxLevels: { type: 'integer', minimum: 1 },
        duplicateApprover: ref('duplicateApprover'),
        excludeRequester: { type: 'boolean', default: false },
        onEmptyApprovers: { enum: ['error', 'skip', 'fallback'], default: 'error' },
        fallbackApprovers: ref('approverList'),
        timeout: ref('timeout'),
        next: ref('nodeRef'),
        onReject: ref('nodeRef'),
      },
    },
    conditionNode: {
      type: 'object',
      required: ['type', 'rules', 'else'],
      additionalProperties: false,
      properties: {
        type: { const: 'condition' },
        label: { type: 'string' },
        rules: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['when', 'next'],
            additionalProperties: false,
            properties: {
              when: { description: 'JSON Logic-style expression.' },
              next: ref('nodeRef'),
              label: { type: 'string' },
            },
          },
        },
        else: ref('nodeRef'),
      },
    },
    endNode: {
      type: 'object',
      required: ['type', 'result'],
      additionalProperties: false,
      properties: {
        type: { const: 'end' },
        label: { type: 'string' },
        result: { enum: ['approved', 'rejected'] },
      },
    },
    node: {
      type: 'object',
      required: ['type'],
      properties: { type: { enum: ['approval', 'approval-chain', 'condition', 'end'] } },
      allOf: [
        {
          if: { properties: { type: { const: 'approval' } } },
          then: { oneOf: [ref('singleGroupApprovalNode'), ref('multiGroupApprovalNode')] },
        },
        {
          if: { properties: { type: { const: 'approval-chain' } } },
          then: ref('approvalChainNode'),
        },
        { if: { properties: { type: { const: 'condition' } } }, then: ref('conditionNode') },
        { if: { properties: { type: { const: 'end' } } }, then: ref('endNode') },
      ],
    },
  },
};
