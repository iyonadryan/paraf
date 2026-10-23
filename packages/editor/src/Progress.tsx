import { createContext, useContext, useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import type {
  AuditEntry,
  FlowDefinition,
  FlowNode,
  InstanceState,
  NodePosition,
} from '@paraf/core';
import { NODE_WIDTHS } from './components/Canvas';
import { CheckIcon, ClockIcon, CloseIcon } from './components/icons';
import { resolveMessages } from './messages';
import type { Messages } from './messages';
import { readPathForDisplay } from './model/display';
import { edgeViews } from './model/graph';
import { autoLayout } from './model/layout';
import { progressOf } from './model/progress';
import type { FlowProgress, NodeProgress } from './model/progress';
import { describeRules } from './model/summary';

/** Props of {@link ParafProgress}. */
export interface ParafProgressProps {
  /** The flow version the instance runs on (`engine.getFlow(flowId, flowVersion)`). */
  flow: FlowDefinition;
  /** The instance with its steps and approver slots (`engine.getInstance(id)`). */
  state: InstanceState;
  /** Its audit trail (`engine.getHistory(id)`). */
  history: readonly AuditEntry[];
  /** Display name of a user; default: the user ID. */
  userName?: (userId: string) => string;
  /** Formats timestamps; default like "Oct 21 · 09:12". */
  formatDate?: (date: Date) => string;
  /** Rendered at the start of the header (e.g. your logo and breadcrumbs). */
  headerStart?: ReactNode;
  messages?: Partial<Messages>;
  className?: string;
  style?: CSSProperties;
}

interface ProgressContextValue {
  messages: Messages;
  userName: (userId: string) => string;
  formatDate: (date: Date) => string;
}

const ProgressContext = createContext<ProgressContextValue | null>(null);

function useProgress(): ProgressContextValue {
  return useContext(ProgressContext) as ProgressContextValue;
}

function defaultFormatDate(date: Date): string {
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

interface ProgressCardData extends Record<string, unknown> {
  id: string;
  node: FlowNode;
  progress: NodeProgress;
}

type ProgressNode = Node<ProgressCardData, 'progress'> | Node<Record<string, never>, 'submitted'>;

const STATUS_CLASS: Record<NodeProgress['status'], string> = {
  done: 'paraf-pnode--done',
  active: 'paraf-pnode--active',
  rejected: 'paraf-pnode--rejected',
  'not-reached': 'paraf-pnode--pending',
};

function StatusMark({ status }: { status: string }) {
  const { messages } = useProgress();
  if (status === 'approved' || status === 'skipped' || status === 'done') {
    return (
      <span className="paraf-mark paraf-mark--done" role="img" aria-label={messages.statusDone}>
        <CheckIcon size={12} />
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span
        className="paraf-mark paraf-mark--rejected"
        role="img"
        aria-label={messages.statusRejected}
      >
        <CloseIcon size={12} />
      </span>
    );
  }
  return (
    <span className="paraf-mark paraf-mark--active" role="img" aria-label={messages.statusActive}>
      <ClockIcon size={14} />
    </span>
  );
}

function ProgressCard({ data }: NodeProps<Node<ProgressCardData, 'progress'>>) {
  const { messages, userName, formatDate } = useProgress();
  const { id, node, progress } = data;
  const label = node.label ?? id;
  const classes = ['paraf-pnode', STATUS_CLASS[progress.status], `paraf-pnode--${node.type}`];
  if (node.type === 'end') {
    classes.push(
      node.result === 'rejected' ? 'paraf-pnode--end-rejected' : 'paraf-pnode--end-approved',
    );
  }

  let details: ReactNode = null;
  if (node.type === 'approval-chain' && progress.levels.length > 0) {
    details = progress.levels.map((level) => (
      <div key={level.level} className={`paraf-pnode__row paraf-pnode__row--${level.status}`}>
        <span>
          {messages.level(level.level)} · {level.userId === null ? '—' : userName(level.userId)}
        </span>
        <StatusMark status={level.status} />
      </div>
    ));
  } else if (
    node.type === 'approval' &&
    progress.status === 'done' &&
    progress.approvedBy.length > 0
  ) {
    details = (
      <>
        <div className="paraf-pnode__line">{progress.approvedBy.map(userName).join(', ')}</div>
        {progress.decidedAt && (
          <div className="paraf-pnode__line paraf-hint">{formatDate(progress.decidedAt)}</div>
        )}
      </>
    );
  } else if (node.type === 'approval' && progress.groups.length > 0) {
    details = progress.groups.map((group) => (
      <div key={group.id} className="paraf-pnode__row">
        <span>{group.label}</span>
        <span>{messages.groupProgress(group.approved, group.required)}</span>
      </div>
    ));
  } else if (node.type === 'approval' && progress.status === 'not-reached') {
    details = (
      <>
        {node.groups ? (
          node.groups.map((group) => (
            <div key={group.id} className="paraf-pnode__row">
              <span>{group.label ?? group.id}</span>
              <span>{describeRules(group, messages).split(' · ')[1]}</span>
            </div>
          ))
        ) : (
          <div className="paraf-pnode__line">{describeRules(node, messages)}</div>
        )}
        <div className="paraf-pnode__line paraf-hint">{messages.notStarted}</div>
      </>
    );
  }

  return (
    <div
      className={classes.join(' ')}
      style={{ width: NODE_WIDTHS[node.type] }}
      data-testid={`progress-${id}`}
    >
      <Handle type="target" position={Position.Top} className="paraf-handle paraf-handle--hidden" />
      {node.type === 'end' ? (
        <div className="paraf-node__end">
          {node.result === 'rejected' ? <CloseIcon size={14} /> : <CheckIcon size={14} />}
          <span>{label}</span>
        </div>
      ) : (
        <>
          <div className="paraf-pnode__head">
            <span className="paraf-node__label">{label}</span>
            {progress.status === 'done' && node.type === 'approval' && <StatusMark status="done" />}
            {progress.status === 'rejected' && <StatusMark status="rejected" />}
          </div>
          {node.type === 'condition' && (
            <span className="paraf-node__kind">{messages.nodeTypes.condition}</span>
          )}
          {details}
        </>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        className="paraf-handle paraf-handle--hidden"
      />
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="paraf-handle paraf-handle--hidden"
      />
    </div>
  );
}

function SubmittedPill() {
  const { messages } = useProgress();
  return (
    <div className="paraf-start" style={{ width: 140 }}>
      <span>{messages.submitted}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="paraf-handle paraf-handle--hidden"
      />
    </div>
  );
}

const NODE_TYPES = { progress: ProgressCard, submitted: SubmittedPill };

function buildGraph(flow: FlowDefinition, progress: FlowProgress, messages: Messages) {
  const layout = { ...autoLayout(flow), ...flow.layout };
  const nodes: ProgressNode[] = Object.entries(flow.nodes).map(([id, node]) => ({
    id,
    type: 'progress',
    position: layout[id] as NodePosition,
    data: { id, node, progress: progress.nodes[id] as NodeProgress },
    draggable: false,
    selectable: false,
  }));
  const startNode = flow.nodes[flow.start];
  const startPosition = layout[flow.start];
  if (startNode && startPosition) {
    nodes.unshift({
      id: '__submitted',
      type: 'submitted',
      position: {
        x: startPosition.x + (NODE_WIDTHS[startNode.type] - 140) / 2,
        y: startPosition.y - 90,
      },
      data: {},
      draggable: false,
      selectable: false,
    });
  }
  const edge = (
    id: string,
    source: string,
    target: string,
    kind: string,
    label: string,
    handle?: string,
  ): Edge => {
    const taken = progress.takenEdges.has(id) || id === '__submitted';
    const color = taken ? (kind === 'reject' ? '#C0362C' : '#3F9A5A') : '#C3C9D2';
    return {
      id,
      source,
      target,
      ...(handle ? { sourceHandle: handle } : {}),
      type: 'smoothstep',
      className: `paraf-edge${taken ? ' paraf-edge--taken' : ''}`,
      style: { stroke: color, strokeWidth: 2, ...(taken ? {} : { strokeDasharray: '6 4' }) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      ...(label
        ? {
            label,
            labelStyle: {
              fontFamily: 'var(--paraf-mono)',
              fontSize: 11,
              fill: taken ? '#146C2E' : '#5B6472',
            },
            labelBgStyle: {
              fill: taken ? '#EAF6EE' : '#FFFFFF',
              stroke: taken ? '#9ED3AE' : '#E1E4EA',
            },
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 4,
          }
        : {}),
    };
  };
  const edges: Edge[] = edgeViews(flow, messages).map((view) =>
    edge(
      view.id,
      view.source,
      view.target,
      view.kind,
      view.label,
      view.kind === 'next' || view.kind === 'else' ? undefined : 'right',
    ),
  );
  if (startNode) edges.unshift(edge('__submitted', '__submitted', flow.start, 'next', ''));
  return { nodes, edges };
}

/** One history entry: who did what, the comment, and when. */
function HistoryItem({ entry, flow }: { entry: AuditEntry; flow: FlowDefinition }) {
  const { messages, userName, formatDate } = useProgress();
  const node = entry.nodeId === null ? undefined : flow.nodes[entry.nodeId];
  const actor = entry.actorId === null ? null : userName(entry.actorId);
  const kind =
    entry.action === 'approved' || entry.action === 'auto_approved' || entry.action === 'completed'
      ? 'done'
      : entry.action === 'rejected' || entry.action === 'cancelled'
        ? 'rejected'
        : entry.actorId === null
          ? 'system'
          : 'actor';
  return (
    <li className="paraf-timeline__item">
      <span className={`paraf-timeline__dot paraf-timeline__dot--${kind}`} />
      <div className="paraf-timeline__body">
        <span>
          {actor ? <b>{actor}</b> : 'System'} {messages.auditActions[entry.action]}
          {node && ` · ${node.label ?? entry.nodeId}`}
        </span>
        {entry.comment && <span className="paraf-timeline__comment">{entry.comment}</span>}
        <span className="paraf-hint">{formatDate(entry.timestamp)}</span>
      </div>
    </li>
  );
}

const SHOWN_ACTIONS = new Set([
  'started',
  'approved',
  'auto_approved',
  'rejected',
  'delegated',
  'returned',
  'resubmitted',
  'escalated',
  'reresolved',
  'condition_evaluated',
  'cancelled',
  'completed',
]);

/**
 * Read-only view of one document's progress through its flow: which steps are done, which
 * one waits for whom, and the history.
 */
export function ParafProgress(props: ParafProgressProps) {
  const messages = useMemo(() => resolveMessages(props.messages), [props.messages]);
  const userName = props.userName ?? ((id: string) => id);
  const formatDate = props.formatDate ?? defaultFormatDate;
  const { flow, state, history } = props;
  const progress = useMemo(() => progressOf(flow, state, history), [flow, state, history]);
  const graph = useMemo(() => buildGraph(flow, progress, messages), [flow, progress, messages]);
  const { instance } = state;
  const activeNode = progress.activeStep ? flow.nodes[progress.activeStep.nodeId] : undefined;
  const statusText = activeNode
    ? `${messages.instanceStatus[instance.status]} · ${activeNode.label ?? progress.activeStep?.nodeId}`
    : messages.instanceStatus[instance.status];

  const classes = ['paraf-editor', 'paraf-progress'];
  if (props.className) classes.push(props.className);

  return (
    <ProgressContext.Provider value={{ messages, userName, formatDate }}>
      <ReactFlowProvider>
        <div className={classes.join(' ')} style={props.style}>
          <header className="paraf-header">
            {props.headerStart}
            <span className="paraf-header__title paraf-mono">{instance.subject.id}</span>
            <span className="paraf-header__spacer" />
            <span className="paraf-hint">{messages.readOnlyVersion(instance.flowVersion)}</span>
          </header>
          <div className="paraf-editor__body">
            <main className="paraf-canvas" aria-label="Progress map">
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={NODE_TYPES}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#CBD1DA" />
                <Panel position="top-left" className="paraf-legend">
                  <span className="paraf-strong">{messages.legend}</span>
                  <span>
                    <i className="paraf-legend__swatch paraf-legend__swatch--done" />
                    {messages.statusDone}
                  </span>
                  <span>
                    <i className="paraf-legend__swatch paraf-legend__swatch--active" />
                    {messages.statusActive}
                  </span>
                  <span>
                    <i className="paraf-legend__swatch paraf-legend__swatch--pending" />
                    {messages.statusNotReached}
                  </span>
                </Panel>
              </ReactFlow>
            </main>
            <aside className="paraf-panel paraf-panel--wide" aria-label={instance.subject.id}>
              <div className="paraf-panel__head">
                <span className={`paraf-badge paraf-badge--status-${instance.status}`}>
                  {statusText}
                </span>
                <span className="paraf-progress__subject paraf-mono">{instance.subject.id}</span>
                <dl className="paraf-facts">
                  <div>
                    <dt>{messages.requester}</dt>
                    <dd>{userName(instance.requesterId)}</dd>
                  </div>
                  {(flow.variables ?? []).map((variable) => (
                    <div key={variable.key}>
                      <dt>{variable.label ?? variable.key}</dt>
                      <dd>{readPathForDisplay(instance.document, variable.key)}</dd>
                    </div>
                  ))}
                  {progress.activeStep?.dueAt && (
                    <div>
                      <dt>{messages.due}</dt>
                      <dd>{formatDate(progress.activeStep.dueAt)}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <section className="paraf-section">
                <h4>{messages.history}</h4>
                <ol className="paraf-timeline">
                  {history
                    .filter((entry) => SHOWN_ACTIONS.has(entry.action))
                    .map((entry) => (
                      <HistoryItem key={entry.id} entry={entry} flow={flow} />
                    ))}
                </ol>
              </section>
            </aside>
          </div>
        </div>
      </ReactFlowProvider>
    </ProgressContext.Provider>
  );
}
