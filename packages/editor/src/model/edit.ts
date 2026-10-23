import type { FlowDefinition, FlowNode, FlowNodeType, NodePosition } from '@paraf/core';

/** Node IDs the engine accepts: letters, digits, `_` and `-`, up to 100 characters. */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Which reference of a node an edge stands for: `next`, `reject`, `else`, or `rule-<n>`. */
export type EdgeHandle = 'next' | 'reject' | 'else' | `rule-${number}`;

type MutableNode = Record<string, unknown>;

function copy(flow: FlowDefinition): FlowDefinition {
  return structuredClone(flow);
}

/** The first `<base>_<n>` that no node uses yet. */
export function uniqueNodeId(flow: FlowDefinition, base: string): string {
  for (let n = 1; ; n++) {
    const id = `${base}_${n}`;
    if (!(id in flow.nodes)) return id;
  }
}

/** A new node of the given type, with sensible defaults; references are left unset. */
export function createNode(
  type: FlowNodeType,
  label: string,
  chains: readonly string[] = [],
): FlowNode {
  switch (type) {
    case 'approval':
      return { type, label, approvers: [], mode: 'any' } as unknown as FlowNode;
    case 'approval-chain':
      return {
        type,
        label,
        ...(chains[0] === undefined ? {} : { chain: chains[0] }),
        maxLevels: 5,
      } as unknown as FlowNode;
    case 'condition':
      return { type, label, rules: [] } as unknown as FlowNode;
    default:
      return { type: 'end', result: 'approved' };
  }
}

/** Adds `node` under a fresh ID at `position`. The first node becomes the start node. */
export function addNode(
  flow: FlowDefinition,
  node: FlowNode,
  idBase: string,
  position: NodePosition,
): { flow: FlowDefinition; id: string } {
  const next = copy(flow);
  const id = uniqueNodeId(flow, idBase);
  next.nodes[id] = node;
  next.layout = { ...next.layout, [id]: { x: Math.round(position.x), y: Math.round(position.y) } };
  if (!next.start || !(next.start in flow.nodes)) next.start = id;
  return { flow: next, id };
}

/** Replaces a node's definition. */
export function replaceNode(flow: FlowDefinition, id: string, node: FlowNode): FlowDefinition {
  const next = copy(flow);
  next.nodes[id] = structuredClone(node);
  return next;
}

/** Calls `visit` for every reference held by `node` (with its handle). */
export function forEachReference(
  node: FlowNode,
  visit: (handle: EdgeHandle, target: string) => void,
): void {
  const raw = node as unknown as MutableNode;
  if (typeof raw.next === 'string') visit('next', raw.next);
  if (typeof raw.onReject === 'string') visit('reject', raw.onReject);
  if (node.type === 'condition') {
    (Array.isArray(node.rules) ? node.rules : []).forEach((rule, index) => {
      if (typeof rule.next === 'string') visit(`rule-${index}`, rule.next);
    });
    if (typeof raw.else === 'string') visit('else', raw.else);
  }
}

/** Sets (or, with `target` undefined, clears) the reference behind `handle`. */
function setReference(node: MutableNode, handle: EdgeHandle, target: string | undefined): void {
  const assign = (owner: MutableNode, key: string) => {
    if (target === undefined) Reflect.deleteProperty(owner, key);
    else owner[key] = target;
  };
  if (handle === 'next') assign(node, 'next');
  else if (handle === 'reject') assign(node, 'onReject');
  else if (handle === 'else') assign(node, 'else');
  else {
    const rule = (node.rules as MutableNode[] | undefined)?.[Number(handle.slice(5))];
    if (rule) assign(rule, 'next');
  }
}

/** Points `handle` of node `source` at `target`. */
export function connect(
  flow: FlowDefinition,
  source: string,
  handle: EdgeHandle,
  target: string,
): FlowDefinition {
  const next = copy(flow);
  const node = next.nodes[source];
  if (node) setReference(node as unknown as MutableNode, handle, target);
  return next;
}

/** Clears `handle` of node `source`. */
export function disconnect(
  flow: FlowDefinition,
  source: string,
  handle: EdgeHandle,
): FlowDefinition {
  const next = copy(flow);
  const node = next.nodes[source];
  if (node) setReference(node as unknown as MutableNode, handle, undefined);
  return next;
}

/** Removes nodes, their positions, and every reference to them. */
export function removeNodes(flow: FlowDefinition, ids: readonly string[]): FlowDefinition {
  const removed = new Set(ids);
  const next = copy(flow);
  for (const id of removed) {
    Reflect.deleteProperty(next.nodes, id);
    if (next.layout) Reflect.deleteProperty(next.layout, id);
  }
  for (const node of Object.values(next.nodes)) {
    const handles: EdgeHandle[] = [];
    forEachReference(node, (handle, target) => {
      if (removed.has(target)) handles.push(handle);
    });
    for (const handle of handles) setReference(node as unknown as MutableNode, handle, undefined);
  }
  if (removed.has(next.start)) next.start = Object.keys(next.nodes)[0] ?? '';
  return next;
}

/**
 * Renames a node and updates every reference, the start node, and the layout. Returns an
 * error key when the new ID is not a valid slug or is taken.
 */
export function renameNode(
  flow: FlowDefinition,
  from: string,
  to: string,
): { flow: FlowDefinition } | { error: 'invalid' | 'taken' } {
  if (from === to) return { flow };
  if (!NODE_ID_PATTERN.test(to)) return { error: 'invalid' };
  if (to in flow.nodes) return { error: 'taken' };

  const next = copy(flow);
  const nodes: Record<string, FlowNode> = {};
  for (const [id, node] of Object.entries(next.nodes)) nodes[id === from ? to : id] = node;
  next.nodes = nodes;
  for (const node of Object.values(nodes)) {
    const handles: EdgeHandle[] = [];
    forEachReference(node, (handle, target) => {
      if (target === from) handles.push(handle);
    });
    for (const handle of handles) setReference(node as unknown as MutableNode, handle, to);
  }
  if (next.start === from) next.start = to;
  if (next.layout && from in next.layout) {
    const layout: Record<string, NodePosition> = {};
    for (const [id, position] of Object.entries(next.layout))
      layout[id === from ? to : id] = position;
    next.layout = layout;
  }
  return { flow: next };
}

/** Stores node positions (rounded to whole pixels). */
export function setPositions(
  flow: FlowDefinition,
  positions: Record<string, NodePosition>,
): FlowDefinition {
  const next = copy(flow);
  const layout = { ...next.layout };
  for (const [id, { x, y }] of Object.entries(positions)) {
    layout[id] = { x: Math.round(x), y: Math.round(y) };
  }
  next.layout = layout;
  return next;
}

/** Changes top-level flow fields; `undefined` removes a field. */
export function updateFlow(
  flow: FlowDefinition,
  patch: {
    [K in 'id' | 'name' | 'start' | 'resubmitPolicy' | 'variables']?: FlowDefinition[K] | undefined;
  },
): FlowDefinition {
  const next = { ...copy(flow), ...structuredClone(patch) };
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    if (patch[key] === undefined) Reflect.deleteProperty(next, key);
  }
  return next;
}

/**
 * Adds a node one row below `source` and connects `handle` of `source` to it; with `source`
 * `null` the new node becomes the start node.
 */
export function addConnectedNode(
  flow: FlowDefinition,
  source: string | null,
  handle: EdgeHandle,
  node: FlowNode,
  idBase: string,
  position: NodePosition,
): { flow: FlowDefinition; id: string } {
  const added = addNode(flow, node, idBase, position);
  const next =
    source === null
      ? updateFlow(added.flow, { start: added.id })
      : connect(added.flow, source, handle, added.id);
  return { flow: next, id: added.id };
}
