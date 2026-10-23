import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  useViewport,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  NodeProps,
  OnSelectionChangeParams,
} from '@xyflow/react';
import type { FlowNode, FlowNodeType, FlowValidationIssue, NodePosition } from '@paraf/core';
import { useEditor } from '../context';
import {
  addConnectedNode,
  addNode,
  connect,
  createNode,
  disconnect,
  removeNodes,
  setPositions,
  updateFlow,
} from '../model/edit';
import type { EdgeHandle } from '../model/edit';
import { edgeViews, handlesOf, mainHandle } from '../model/graph';
import type { EdgeKind, HandleView } from '../model/graph';
import { autoLayout, below } from '../model/layout';
import { describeChain, describeDuration, describeRequire, describeRules } from '../model/summary';
import { applyTemplate } from '../model/templates';
import type { TemplateId } from '../model/templates';
import { MenuButton } from './fields';
import { CheckIcon, CloseIcon, NodeTypeIcon, PlayIcon } from './icons';

/** MIME type of palette items being dragged onto the canvas. */
export const DRAG_TYPE = 'application/x-paraf-node';

/** ID of the Start pill, which is not a flow node. */
export const START_ID = '__start';

/** Width of each card, used to center the Start pill and new nodes. */
export const NODE_WIDTHS: Record<FlowNodeType, number> = {
  approval: 260,
  'approval-chain': 260,
  condition: 220,
  end: 180,
};
const START_WIDTH = 140;
/** Where the Start pill sits while the flow has no start node. */
const EMPTY_START = { x: 100, y: 0 };
/** Fit the flow, but never zoom in past 100%. */
const FIT = { padding: 0.2, maxZoom: 1 };

export interface CardData extends Record<string, unknown> {
  node: FlowNode;
  issues: FlowValidationIssue[];
  issueNumber: number | null;
  handles: HandleView[];
  chainLabel: string;
}

type CardNode = Node<CardData, 'card'>;
type StartNode = Node<{ connected: boolean }, 'start'>;
type EmptyNode = Node<Record<string, never>, 'empty'>;
type CanvasNode = CardNode | StartNode | EmptyNode;

/** ID of the empty-state card, shown as a canvas node so menus can open above it. */
const EMPTY_ID = '__empty';
const EMPTY_WIDTH = 480;

const NODE_TYPES_ORDER: FlowNodeType[] = ['approval', 'approval-chain', 'condition', 'end'];

/** "+" under a node: add the next node, already connected. */
function QuickAdd(props: { source: string | null; handle: EdgeHandle; label: string }) {
  const { flow, commit, messages, chains, select } = useEditor();
  const { getNode } = useReactFlow();
  return (
    <div className="paraf-quick-add nodrag nopan">
      <MenuButton
        variant="plus"
        label="+"
        buttonLabel={messages.addNext}
        title={messages.addAfter(props.label)}
        items={NODE_TYPES_ORDER.map((type) => ({
          key: type,
          title: messages.nodeTypes[type],
          description: messages.nodeTypeHints[type],
          icon: (
            <span className={`paraf-tile paraf-tile--${type}`}>
              <NodeTypeIcon type={type} size={14} />
            </span>
          ),
        }))}
        onSelect={(key) => {
          const type = key as FlowNodeType;
          const from = props.source === null ? undefined : getNode(props.source);
          const origin: NodePosition | undefined = from
            ? {
                x:
                  from.position.x +
                  (NODE_WIDTHS[(from.data as CardData).node.type] - NODE_WIDTHS[type]) / 2,
                y: from.position.y,
              }
            : undefined;
          const result = addConnectedNode(
            flow,
            props.source,
            props.handle,
            createNode(
              type,
              messages.newNodeLabels[type],
              chains.map((chain) => chain.name),
            ),
            messages.nodeIdBases[type],
            below(origin),
          );
          commit(result.flow);
          select(result.id);
        }}
      />
    </div>
  );
}

function SourceHandle({
  handle,
  index,
  total,
}: {
  handle: HandleView;
  index: number;
  total: number;
}) {
  const style =
    handle.side === 'right'
      ? { top: `${Math.round(((index + 1) / (total + 1)) * 100)}%` }
      : undefined;
  return (
    <Handle
      type="source"
      id={handle.id}
      position={handle.side === 'right' ? Position.Right : Position.Bottom}
      className={`paraf-handle paraf-handle--${handle.kind}`}
      style={style}
      data-testid={`handle-${handle.id}`}
    />
  );
}

/** A flow node on the canvas. */
export function NodeCard({ id, data, selected }: NodeProps<CardNode>) {
  const { messages, readOnly } = useEditor();
  const { node, issues, issueNumber, handles, chainLabel } = data;
  const right = handles.filter((handle) => handle.side === 'right');
  const bottom = handles.filter((handle) => handle.side === 'bottom');
  const main = mainHandle(node);
  const showAdd = !readOnly && main !== null && !handles.some((h) => h.id === main && h.connected);
  const classes = ['paraf-node', `paraf-node--${node.type}`];
  if (node.type === 'end')
    classes.push(`paraf-node--${node.result === 'rejected' ? 'rejected' : 'approved'}`);
  if (issues.length > 0) classes.push('paraf-node--invalid');
  if (selected) classes.push('paraf-node--selected');
  const label = node.label ?? id;

  let body;
  if (node.type === 'end') {
    body = (
      <div className="paraf-node__end">
        {node.result === 'rejected' ? <CloseIcon size={14} /> : <CheckIcon size={14} />}
        <span>{label}</span>
      </div>
    );
  } else {
    let kind = messages.nodeTypes[node.type];
    let lines: string[] = [];
    let groups: { label: string; mode: string }[] = [];
    let footer: string | null = null;
    if (node.type === 'approval') {
      if (node.groups) {
        kind = `${kind} · ${messages.parallelGroups(node.groups.length)}`;
        groups = node.groups.map((group) => {
          const [, mode = ''] = describeRules(group, messages).split(' · ');
          return { label: group.label ?? group.id, mode };
        });
        footer = describeRequire(node.require, messages);
      } else {
        lines = [describeRules(node, messages)];
      }
    } else if (node.type === 'approval-chain') {
      lines = describeChain(node, messages, chainLabel);
    }
    const timeout = node.type !== 'condition' ? node.timeout : undefined;
    if (timeout) lines.push(messages.timeoutSummary(describeDuration(timeout.after, messages)));
    body = (
      <>
        <div className="paraf-node__kind">
          <NodeTypeIcon type={node.type} size={12} />
          <span>{kind}</span>
        </div>
        <div className="paraf-node__label">{label}</div>
        {lines.map((line, index) => (
          <div key={index} className="paraf-node__line">
            {line}
          </div>
        ))}
        {groups.map((group, index) => (
          <div key={index} className="paraf-node__group">
            <span>{group.label}</span>
            <span className="paraf-hint">{group.mode}</span>
          </div>
        ))}
        {footer && <div className="paraf-node__footer">{footer}</div>}
      </>
    );
  }

  return (
    <div
      className={classes.join(' ')}
      style={{ width: NODE_WIDTHS[node.type] }}
      data-testid={`node-${id}`}
      title={issues.map((issue) => issue.message).join('\n') || undefined}
    >
      <Handle type="target" position={Position.Top} className="paraf-handle paraf-handle--target" />
      {body}
      {issueNumber !== null && (
        <span className="paraf-node__badge" aria-label={`${messages.problems} ${issueNumber}`}>
          {issueNumber}
        </span>
      )}
      {right.map((handle, index) => (
        <SourceHandle key={handle.id} handle={handle} index={index} total={right.length} />
      ))}
      {bottom.map((handle) => (
        <SourceHandle key={handle.id} handle={handle} index={0} total={1} />
      ))}
      {showAdd && <QuickAdd source={id} handle={main} label={label} />}
    </div>
  );
}

/** The Start pill; its handle (or "+") sets the flow's start node. */
function StartPill({ data }: NodeProps<StartNode>) {
  const { messages, readOnly } = useEditor();
  return (
    <div className="paraf-start" style={{ width: START_WIDTH }} data-testid="node-start">
      <PlayIcon size={14} />
      <span>{messages.start}</span>
      <Handle type="source" id="start" position={Position.Bottom} className="paraf-handle" />
      {!data.connected && !readOnly && (
        <QuickAdd source={null} handle="next" label={messages.start} />
      )}
    </div>
  );
}

const NODE_TYPES = { card: NodeCard, start: StartPill, empty: EmptyState };

const EDGE_COLORS: Record<EdgeKind, string> = {
  next: '#8A93A3',
  rule: '#8A93A3',
  else: '#8A93A3',
  reject: '#C0362C',
};

/** Zoom out / level / zoom in / tidy up, as in the design's bottom-left panel. */
function ZoomPanel() {
  const { flow, commit, messages, readOnly } = useEditor();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel position="bottom-left" className="paraf-zoom">
      <button type="button" aria-label={messages.zoomOut} onClick={() => void zoomOut()}>
        −
      </button>
      <button
        type="button"
        className="paraf-zoom__level"
        title={messages.fitView}
        aria-label={messages.fitView}
        onClick={() => void fitView(FIT)}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label={messages.zoomIn} onClick={() => void zoomIn()}>
        +
      </button>
      {!readOnly && (
        <button
          type="button"
          className="paraf-zoom__tidy"
          onClick={() => {
            commit(setPositions(flow, autoLayout(flow)));
            requestAnimationFrame(() => void fitView(FIT));
          }}
        >
          {messages.tidyUp}
        </button>
      )}
    </Panel>
  );
}

/** Shown on an empty canvas: the steps to a valid flow, and templates. */
function EmptyState() {
  const { flow, commit, messages, readOnly, approverTypes } = useEditor();
  const { fitView } = useReactFlow();
  const done = [flow.name.trim() !== '', (flow.variables ?? []).length > 0, false, false, false];
  const templates: TemplateId[] = ['single', 'multi', 'amount'];
  return (
    <div className="paraf-empty nodrag nopan" style={{ width: EMPTY_WIDTH }}>
      <div className="paraf-empty__intro">
        <span className="paraf-empty__title">{messages.emptyTitle}</span>
        <span className="paraf-hint">{messages.emptyText}</span>
      </div>
      <ol className="paraf-steps">
        {messages.emptySteps.map((step, index) => (
          <li key={index}>
            <span className={`paraf-steps__mark${done[index] ? ' paraf-steps__mark--done' : ''}`}>
              {done[index] ? <CheckIcon size={12} /> : index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {!readOnly && (
        <>
          <div className="paraf-divider" />
          <span className="paraf-overline">{messages.templatesTitle}</span>
          <div className="paraf-templates">
            {templates.map((template) => (
              <button
                key={template}
                type="button"
                className="paraf-template"
                onClick={() => {
                  commit(applyTemplate(flow, template, approverTypes[0]?.type ?? 'user'));
                  requestAnimationFrame(() => void fitView(FIT));
                }}
              >
                <span className="paraf-strong">{messages.templates[template][0]}</span>
                <span className="paraf-hint">{messages.templates[template][1]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The flow drawn with React Flow: drag, connect, select, delete. */
export function Canvas() {
  const { flow, commit, messages, readOnly, issues, select, selectedNodeId, chains } = useEditor();
  const { screenToFlowPosition, setViewport } = useReactFlow();
  const canvas = useRef<HTMLElement>(null);
  const empty = Object.keys(flow.nodes).length === 0;

  // An empty flow shows the Start pill near the top, above the empty-state card.
  useEffect(() => {
    if (!empty) return;
    const width = (canvas.current as HTMLElement).clientWidth;
    const frame = requestAnimationFrame(() => {
      void setViewport({ x: width / 2 - (EMPTY_START.x + START_WIDTH / 2), y: 40, zoom: 1 });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [empty, setViewport]);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const hasStart = flow.start in flow.nodes;

  // Nodes without a stored position (e.g. a flow published from code) are laid out top to bottom.
  const autoPositions = useMemo(() => autoLayout(flow), [flow]);

  const cards = useMemo(() => {
    const firstIssue = new Map<string, number>();
    issues.forEach((issue, index) => {
      if (issue.nodeId !== undefined && !firstIssue.has(issue.nodeId))
        firstIssue.set(issue.nodeId, index + 1);
    });
    return Object.entries(flow.nodes).map(([id, node]) => ({
      id,
      data: {
        node,
        issues: issues.filter((issue) => issue.nodeId === id),
        issueNumber: firstIssue.get(id) ?? null,
        handles: handlesOf(node),
        chainLabel:
          node.type === 'approval-chain'
            ? (chains.find((chain) => chain.name === node.chain)?.label ?? node.chain)
            : '',
      } satisfies CardData,
    }));
  }, [flow.nodes, issues, chains]);

  // React Flow keeps measurements and selection on its nodes, so derived nodes are merged into
  // that state. Selection stays as the canvas has it: clicking a handle selects its node in the
  // same update that commits a connection, and overriding it here would make the two fight.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      const cardNodes = cards.map(({ id, data }): CardNode => {
        const current = byId.get(id) as CardNode | undefined;
        return {
          ...current,
          id,
          type: 'card',
          data,
          position: flow.layout?.[id] ?? (autoPositions[id] as NodePosition),
          selected: current?.selected ?? id === selectedNodeId,
        };
      });
      const startCard = cardNodes.find((node) => node.id === flow.start);
      const startPosition = startCard
        ? {
            x: startCard.position.x + (NODE_WIDTHS[startCard.data.node.type] - START_WIDTH) / 2,
            y: startCard.position.y - 90,
          }
        : EMPTY_START;
      const start: StartNode = {
        ...(byId.get(START_ID) as StartNode | undefined),
        id: START_ID,
        type: 'start',
        data: { connected: hasStart },
        position: startPosition,
        draggable: false,
        selectable: false,
        deletable: false,
        zIndex: 10,
      };
      if (cardNodes.length > 0) return [start, ...cardNodes];
      const emptyCard: EmptyNode = {
        id: EMPTY_ID,
        type: 'empty',
        data: {},
        position: { x: EMPTY_START.x + START_WIDTH / 2 - EMPTY_WIDTH / 2, y: 150 },
        draggable: false,
        selectable: false,
        deletable: false,
        zIndex: 0,
      };
      return [start, emptyCard];
    });
  }, [cards, autoPositions, flow.layout, flow.start, hasStart, selectedNodeId]);

  // A selection made outside the canvas (side panel, problems list, a new node) is shown on it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNodes((previous) =>
      previous.map((node) =>
        node.selectable === false || Boolean(node.selected) === (node.id === selectedNodeId)
          ? node
          : { ...node, selected: node.id === selectedNodeId },
      ),
    );
  }, [selectedNodeId]);

  const edges = useMemo((): Edge[] => {
    const style = (kind: EdgeKind) => ({
      stroke: EDGE_COLORS[kind],
      strokeWidth: 2,
      ...(kind === 'reject' ? { strokeDasharray: '6 4' } : {}),
    });
    const list: Edge[] = edgeViews(flow, messages).map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      type: 'smoothstep',
      className: `paraf-edge paraf-edge--${edge.kind}`,
      style: style(edge.kind),
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: EDGE_COLORS[edge.kind],
        width: 16,
        height: 16,
      },
      selected: selectedEdges.has(edge.id),
      ...(edge.label
        ? {
            label: edge.label,
            labelStyle: {
              fontFamily: 'var(--paraf-mono)',
              fontSize: 11,
              fill: edge.kind === 'reject' ? '#A32A21' : '#3D4450',
              fontWeight: edge.kind === 'reject' ? 600 : 400,
            },
            labelBgStyle: {
              fill: '#FFFFFF',
              stroke: edge.kind === 'reject' ? '#F1C7C3' : '#E1E4EA',
            },
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 4,
          }
        : {}),
    }));
    if (hasStart) {
      list.unshift({
        id: `${START_ID}:start`,
        source: START_ID,
        sourceHandle: 'start',
        target: flow.start,
        type: 'smoothstep',
        className: 'paraf-edge paraf-edge--next',
        style: style('next'),
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS.next, width: 16, height: 16 },
        selected: selectedEdges.has(`${START_ID}:start`),
      });
    }
    return list;
  }, [flow, messages, selectedEdges, hasStart]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const removed = changes.flatMap((change) =>
        change.type === 'remove' && change.id !== START_ID ? [change.id] : [],
      );
      if (removed.length > 0) {
        commit(removeNodes(flow, removed));
        select(null);
      }
      setNodes((current) =>
        applyNodeChanges(
          changes.filter((change) => change.type !== 'remove'),
          current,
        ),
      );
    },
    [flow, commit, select],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let next = flow;
      for (const change of changes) {
        if (change.type !== 'remove') continue;
        const [source, handle] = change.id.split(':') as [string, EdgeHandle];
        next =
          source === START_ID ? updateFlow(next, { start: '' }) : disconnect(next, source, handle);
      }
      if (next !== flow) commit(next);
      setSelectedEdges((current) => {
        const selected = new Set(current);
        for (const change of changes) {
          if (change.type === 'select') {
            if (change.selected) selected.add(change.id);
            else selected.delete(change.id);
          }
        }
        return selected;
      });
    },
    [flow, commit],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // Every source handle has an ID, and the Start pill has no target handle.
      if (connection.source === START_ID) commit(updateFlow(flow, { start: connection.target }));
      else
        commit(
          connect(
            flow,
            connection.source,
            connection.sourceHandle as EdgeHandle,
            connection.target,
          ),
        );
    },
    [flow, commit],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams) => {
      select(selected.find((node) => node.id !== START_ID)?.id ?? null);
    },
    [select],
  );

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData(DRAG_TYPE) as FlowNodeType | '';
    // In read-only mode `commit` does nothing, so the drop is ignored.
    if (!type) return;
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const result = addNode(
      flow,
      createNode(
        type,
        messages.newNodeLabels[type],
        chains.map((chain) => chain.name),
      ),
      messages.nodeIdBases[type],
      { x: point.x - NODE_WIDTHS[type] / 2, y: point.y - 30 },
    );
    commit(result.flow);
    select(result.id);
  };

  return (
    <main
      ref={canvas}
      className="paraf-canvas"
      aria-label="Flow canvas"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={onDrop}
    >
      <ReactFlow<CanvasNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={(_event, _node, dragged) => {
          // Only cards are draggable; the Start pill and the empty state are not.
          commit(
            setPositions(flow, Object.fromEntries(dragged.map((node) => [node.id, node.position]))),
          );
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView={!empty}
        fitViewOptions={FIT}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#CBD1DA" />
        <ZoomPanel />
        <MiniMap
          pannable
          zoomable
          className="paraf-minimap"
          style={{ width: 168, height: 120 }}
          maskColor="rgba(244, 245, 247, 0.6)"
          nodeBorderRadius={3}
          nodeColor={(node) => {
            if (node.type === 'start') return '#1A1D23';
            if (node.type === 'empty') return 'transparent';
            const card = node.data as CardData;
            if (card.node.type === 'end')
              return card.node.result === 'rejected' ? '#F1C7C3' : '#B9E0C4';
            return { approval: '#C9D4F5', 'approval-chain': '#BFE2DA', condition: '#F2D9B3' }[
              card.node.type
            ];
          }}
        />
      </ReactFlow>
    </main>
  );
}
