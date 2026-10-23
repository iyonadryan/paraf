import type { FlowDefinition, FlowNode, NodePosition } from '@paraf/core';
import { forEachReference } from './edit';

/** Horizontal distance between columns. */
export const COLUMN_WIDTH = 320;
/** Vertical distance between rows. */
export const ROW_HEIGHT = 190;
/** The first row sits below the Start pill. */
const TOP = 120;
const LEFT = 40;

/**
 * Top-to-bottom layered layout: each node goes one row below the earliest node that leads to
 * it (breadth-first from the start node); nodes not reachable from the start go last.
 */
export function autoLayout(flow: FlowDefinition): Record<string, NodePosition> {
  const depth = new Map<string, number>();
  const order: string[] = [];
  const visit = (id: string, level: number) => {
    depth.set(id, level);
    order.push(id);
  };
  if (flow.start in flow.nodes) visit(flow.start, 0);
  for (let index = 0; index < order.length; index++) {
    const id = order[index] as string;
    forEachReference(flow.nodes[id] as FlowNode, (_handle, target) => {
      if (target in flow.nodes && !depth.has(target)) visit(target, (depth.get(id) as number) + 1);
    });
  }
  const lastRow = Math.max(-1, ...depth.values());
  for (const id of Object.keys(flow.nodes)) {
    if (!depth.has(id)) visit(id, lastRow + 1);
  }

  const columns = new Map<number, number>();
  const positions: Record<string, NodePosition> = {};
  for (const id of order) {
    const row = depth.get(id) as number;
    const column = columns.get(row) ?? 0;
    columns.set(row, column + 1);
    positions[id] = { x: LEFT + column * COLUMN_WIDTH, y: TOP + row * ROW_HEIGHT };
  }
  return positions;
}

/** Where a node continuing from `source` goes: one row below it. */
export function below(position: NodePosition | undefined): NodePosition {
  return position ? { x: position.x, y: position.y + ROW_HEIGHT } : { x: LEFT, y: TOP };
}
