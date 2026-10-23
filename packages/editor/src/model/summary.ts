import { parseDuration } from '@paraf/core';
import type {
  ApprovalChainNode,
  ApprovalMode,
  ApproverEntry,
  ApproverGroupRules,
  ConditionExpression,
  GroupRequirement,
} from '@paraf/core';
import type { Messages } from '../messages';
import { parseCondition } from './condition';

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'number') return value.toLocaleString('en-US');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `Role: manager`, `Supervisor (level 1)`, `User: u1, u2`. */
export function describeApprover(entry: ApproverEntry): string {
  const { type, value, ...config } = entry;
  const settings = Object.entries(config)
    .filter(([, setting]) => setting !== undefined)
    .map(([key, setting]) => `${key} ${formatValue(setting)}`);
  const base =
    value === undefined ? capitalize(type) : `${capitalize(type)}: ${formatValue(value)}`;
  return settings.length > 0 ? `${base} (${settings.join(', ')})` : base;
}

/** `any 1`, `all`, `at least 3`. */
export function describeMode(mode: ApprovalMode | undefined, messages: Messages): string {
  if (mode === 'all') return messages.modeAll;
  if (typeof mode === 'object') return messages.modeMinimum(mode.minimum);
  return messages.modeAny;
}

/** The approvers of one group with how many must approve, e.g. `Role: manager · any 1`. */
export function describeRules(rules: Partial<ApproverGroupRules>, messages: Messages): string {
  const approvers =
    rules.approvers && rules.approvers.length > 0
      ? rules.approvers.map(describeApprover).join(', ')
      : messages.noApprovers;
  return `${approvers} · ${describeMode(rules.mode, messages)}`;
}

export function describeRequire(require: GroupRequirement | undefined, messages: Messages): string {
  if (require === 'any') return messages.requireAny;
  if (typeof require === 'object') return messages.requireMinimum(require.minimum);
  return messages.requireAll;
}

/** `3 days`, `12 hours`, `1 day 6 hours`; the raw text when it is not a duration. */
export function describeDuration(text: string, messages: Messages): string {
  const duration = parseDuration(text);
  if (!duration) return text;
  const parts = (Object.keys(messages.durationUnits) as (keyof Messages['durationUnits'])[])
    .filter((unit) => duration[unit] > 0)
    .map((unit) => {
      const count = duration[unit];
      return `${count} ${messages.durationUnits[unit]}${count === 1 ? '' : 's'}`;
    });
  return parts.length > 0 ? parts.join(' ') : text;
}

/** Summary lines of an approval-chain node. */
export function describeChain(
  node: ApprovalChainNode,
  messages: Messages,
  chainLabel: string,
): string[] {
  const first = [messages.chainSummary(chainLabel)];
  if (node.until) first.push(messages.chainUntil(describeApprover(node.until).toLowerCase()));
  const second: string[] = [];
  if (typeof node.maxLevels === 'number') second.push(messages.maxLevelsSummary(node.maxLevels));
  if (node.duplicateApprover === 'auto-approve') second.push(messages.duplicatesAuto);
  return [first.join(' · '), ...(second.length > 0 ? [second.join(' · ')] : [])];
}

/** A rule's condition in words for its edge, e.g. `amount > 10,000,000`; `null` if too complex. */
export function describeCondition(expression: ConditionExpression | undefined): string | null {
  const model = parseCondition(expression);
  if (!model || model.comparisons.length === 0) return null;
  return model.comparisons
    .map((comparison) => {
      const value =
        typeof comparison.value === 'string'
          ? `"${comparison.value}"`
          : Array.isArray(comparison.value)
            ? `[${formatValue(comparison.value)}]`
            : formatValue(comparison.value);
      return `${comparison.field} ${comparison.operator} ${value}`;
    })
    .join(` ${model.combinator} `);
}
