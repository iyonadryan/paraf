import type { FlowDefinition, FlowNode } from '@paraf/core';
import type { Messages } from '../messages';

/** One line of "changes since the active version". */
export interface FlowChange {
  kind: 'added' | 'changed' | 'removed';
  text: string;
}

const FLOW_FIELDS = ['name', 'start', 'resubmitPolicy', 'variables'] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedFields(before: FlowNode, after: FlowNode): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) =>
      !same(
        (before as unknown as Record<string, unknown>)[key],
        (after as unknown as Record<string, unknown>)[key],
      ),
  );
}

/**
 * What changed between the active version and the draft: flow settings, and nodes added,
 * removed, or changed (with the fields that differ). Positions are ignored.
 */
export function diffFlows(
  before: FlowDefinition,
  after: FlowDefinition,
  messages: Messages,
): FlowChange[] {
  const changes: FlowChange[] = [];
  const flowFields = FLOW_FIELDS.filter((field) => !same(before[field], after[field]));
  if (flowFields.length > 0) {
    changes.push({ kind: 'changed', text: messages.changeText.flowChanged(flowFields.join(', ')) });
  }
  const name = (id: string, node: FlowNode) => node.label ?? id;
  for (const [id, node] of Object.entries(after.nodes)) {
    const previous = before.nodes[id];
    if (!previous) {
      changes.push({
        kind: 'added',
        text: messages.changeText.nodeAdded(name(id, node), messages.nodeTypes[node.type]),
      });
    } else {
      const fields = changedFields(previous, node);
      if (fields.length > 0) {
        changes.push({
          kind: 'changed',
          text: messages.changeText.nodeChanged(name(id, node), fields.join(', ')),
        });
      }
    }
  }
  for (const [id, node] of Object.entries(before.nodes)) {
    if (!(id in after.nodes)) {
      changes.push({ kind: 'removed', text: messages.changeText.nodeRemoved(name(id, node)) });
    }
  }
  return changes;
}
