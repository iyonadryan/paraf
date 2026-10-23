import type { FlowDefinition, FlowNode } from '@paraf/core';
import type { Messages } from '../messages';
import { forEachReference } from './edit';
import type { EdgeHandle } from './edit';
import { describeCondition } from './summary';

/** Visual kind of an edge. */
export type EdgeKind = 'next' | 'reject' | 'rule' | 'else';

/** One reference between nodes, drawn as an edge. */
export interface EdgeView {
  id: string;
  source: string;
  sourceHandle: EdgeHandle;
  target: string;
  kind: EdgeKind;
  /** Text on the edge; empty for plain `next` edges. */
  label: string;
}

/** A source handle of a node and where it sits on the card. */
export interface HandleView {
  id: EdgeHandle;
  kind: EdgeKind;
  /** `bottom` for the main path, `right` for rejects and condition rules. */
  side: 'bottom' | 'right';
  /** Whether a reference already uses it. */
  connected: boolean;
}

export function kindOf(handle: EdgeHandle): EdgeKind {
  if (handle === 'next' || handle === 'reject' || handle === 'else') return handle;
  return 'rule';
}

function ruleLabel(node: FlowNode, handle: EdgeHandle, messages: Messages): string {
  const index = Number(handle.slice(5));
  const rule =
    node.type === 'condition' && Array.isArray(node.rules) ? node.rules[index] : undefined;
  return rule?.label ?? describeCondition(rule?.when) ?? `${messages.if} #${index + 1}`;
}

/** Text shown on an edge leaving `node` through `handle`. */
export function edgeLabel(node: FlowNode, handle: EdgeHandle, messages: Messages): string {
  switch (kindOf(handle)) {
    case 'reject':
      return messages.edgeReject;
    case 'else':
      return messages.edgeElse;
    case 'rule':
      return ruleLabel(node, handle, messages);
    default:
      return '';
  }
}

/** The handle a "+" below the node continues from, if any. */
export function mainHandle(node: FlowNode): EdgeHandle | null {
  if (node.type === 'condition') return 'else';
  if (node.type === 'end') return null;
  return 'next';
}

/** The source handles a node offers. */
export function handlesOf(node: FlowNode): HandleView[] {
  const used = new Set<EdgeHandle>();
  forEachReference(node, (handle) => used.add(handle));
  const ids: EdgeHandle[] =
    node.type === 'condition'
      ? [
          'else',
          ...(Array.isArray(node.rules) ? node.rules : []).map(
            (_rule, index): EdgeHandle => `rule-${index}`,
          ),
        ]
      : node.type === 'end'
        ? []
        : ['next', 'reject'];
  return ids.map((id) => ({
    id,
    kind: kindOf(id),
    side: id === 'next' || id === 'else' ? 'bottom' : 'right',
    connected: used.has(id),
  }));
}

/** Every reference that points at an existing node. */
export function edgeViews(flow: FlowDefinition, messages: Messages): EdgeView[] {
  const edges: EdgeView[] = [];
  for (const [source, node] of Object.entries(flow.nodes)) {
    forEachReference(node, (handle, target) => {
      if (!(target in flow.nodes)) return;
      edges.push({
        id: `${source}:${handle}`,
        source,
        sourceHandle: handle,
        target,
        kind: kindOf(handle),
        label: edgeLabel(node, handle, messages),
      });
    });
  }
  return edges;
}
