import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { FlowDefinition, FlowNodeType } from '@paraf/core';
import { useEditor } from '../context';
import { addNode, createNode } from '../model/edit';
import { diffFlows } from '../model/diff';
import { edgeViews } from '../model/graph';
import { below } from '../model/layout';
import { AlertIcon, CheckIcon, InfoIcon, NodeTypeIcon, RedoIcon, UndoIcon } from './icons';
import { DRAG_TYPE } from './Canvas';

const NODE_TYPES: FlowNodeType[] = ['approval', 'approval-chain', 'condition', 'end'];

/** Publishing support: the app persists the version (e.g. with `engine.publishFlow`). */
export interface EditorPublishOptions {
  /** Version new instances use now, or `null` if the flow was never published. */
  activeVersion?: number | null;
  /**
   * Highest stored version, when it differs from the active one (after a rollback); the next
   * version is numbered after it. Default: `activeVersion`.
   */
  latestVersion?: number | null;
  /** The active version's definition, to list the changes since. */
  activeFlow?: FlowDefinition | null;
  /** Documents still running on the active version (shown in the publish dialog). */
  runningInstances?: number;
  /**
   * Where the version goes, e.g. "PRODUCTION" or "staging database"; shown in the publish
   * dialog so nobody publishes to the wrong database by accident.
   */
  target?: string;
  /** Called with the flow and release notes when the user confirms. */
  onPublish: (flow: FlowDefinition, notes: string) => void | Promise<void>;
}

/** The number the next published version gets. */
function nextVersion(publish: EditorPublishOptions): number {
  return (publish.latestVersion ?? publish.activeVersion ?? 0) + 1;
}

/** Whether no version of the flow exists yet. */
function neverPublished(publish: EditorPublishOptions): boolean {
  return nextVersion(publish) === 1;
}

/** Node types to drag onto the canvas (or click to add below the lowest node). */
export function Palette() {
  const { flow, commit, messages, chains, approverTypes, select } = useEditor();
  const add = (type: FlowNodeType) => {
    const positions = Object.values(flow.layout ?? {});
    const lowest = positions.reduce<{ x: number; y: number } | undefined>(
      (found, position) => (!found || position.y > found.y ? position : found),
      undefined,
    );
    const result = addNode(
      flow,
      createNode(
        type,
        messages.newNodeLabels[type],
        chains.map((chain) => chain.name),
      ),
      messages.nodeIdBases[type],
      below(lowest),
    );
    commit(result.flow);
    select(result.id);
  };
  return (
    <nav className="paraf-palette" aria-label={messages.palette}>
      <span className="paraf-overline">{messages.palette}</span>
      {NODE_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          draggable
          className="paraf-palette__item"
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_TYPE, type);
            event.dataTransfer.effectAllowed = 'move';
          }}
          onClick={() => {
            add(type);
          }}
        >
          <span className={`paraf-tile paraf-tile--${type}`}>
            <NodeTypeIcon type={type} size={16} />
          </span>
          <span className="paraf-palette__text">
            <span className="paraf-strong">{messages.nodeTypes[type]}</span>
            <span className="paraf-hint">{messages.nodeTypeHints[type]}</span>
          </span>
        </button>
      ))}
      <div className="paraf-divider" />
      <span className="paraf-overline">{messages.waysToAdd}</span>
      <ul className="paraf-tips">
        {messages.waysToAddTips.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>
      {approverTypes.length > 0 && (
        <>
          <div className="paraf-divider" />
          <span className="paraf-overline">{messages.registeredTypes}</span>
          <div className="paraf-chips">
            {approverTypes.map((type) => (
              <span key={type.type} className="paraf-chip paraf-chip--neutral">
                {type.label}
              </span>
            ))}
          </div>
        </>
      )}
    </nav>
  );
}

/** Minimal shape check before an imported file replaces the flow. */
function parseFlow(text: string): FlowDefinition {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('not a JSON object');
  }
  const nodes = (value as { nodes?: unknown }).nodes;
  if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) {
    throw new Error('"nodes" must be an object');
  }
  return value as FlowDefinition;
}

export interface HeaderHistory {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** Title, version badge, undo/redo, import/export, publish. */
export function Header(props: {
  history: HeaderHistory;
  publish: EditorPublishOptions | undefined;
  start: ReactNode;
  onPublishClick: () => void;
}) {
  const { flow, commit, messages, readOnly, issues, select } = useEditor();
  const { fitView } = useReactFlow();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const { publish } = props;
  const active = publish?.activeVersion ?? null;

  const exportJson = () => {
    const blob = new Blob([`${JSON.stringify(flow, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${flow.id || 'flow'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file: File) => {
    try {
      const imported = parseFlow(await file.text());
      setImportError(null);
      commit(imported);
      select(null);
      requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1 }));
    } catch (error) {
      // JSON.parse and parseFlow throw Errors.
      setImportError(messages.importFailed((error as Error).message));
    }
  };

  return (
    <header className="paraf-header">
      {props.start}
      <span className="paraf-header__title">{flow.name || flow.id}</span>
      {publish &&
        (neverPublished(publish) ? (
          <span className="paraf-badge paraf-badge--neutral">{messages.draftNeverPublished}</span>
        ) : (
          <>
            <span className="paraf-badge paraf-badge--draft">
              {messages.draftVersion(nextVersion(publish))}
            </span>
            {active !== null && (
              <span className="paraf-hint">{messages.activeVersion(active)}</span>
            )}
          </>
        ))}
      <span className="paraf-header__spacer" />
      {importError && (
        <span className="paraf-error" role="alert">
          {importError}
        </span>
      )}
      {publish && !readOnly && issues.length > 0 && (
        <span className="paraf-header__warn">{messages.fixBeforePublishing(issues.length)}</span>
      )}
      {!readOnly && (
        <>
          <button
            type="button"
            className="paraf-button paraf-button--square"
            aria-label={messages.undo}
            title={messages.undo}
            disabled={!props.history.canUndo}
            onClick={props.history.undo}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="paraf-button paraf-button--square"
            aria-label={messages.redo}
            title={messages.redo}
            disabled={!props.history.canRedo}
            onClick={props.history.redo}
          >
            <RedoIcon />
          </button>
          <button
            type="button"
            className="paraf-button"
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            {messages.importJson}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            data-testid="paraf-import"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importJson(file);
            }}
          />
        </>
      )}
      <button type="button" className="paraf-button" onClick={exportJson}>
        {messages.exportJson}
      </button>
      {publish && !readOnly && (
        <button
          type="button"
          className="paraf-button paraf-button--primary"
          disabled={issues.length > 0}
          onClick={props.onPublishClick}
        >
          {neverPublished(publish)
            ? messages.publish
            : messages.publishVersion(nextVersion(publish))}
        </button>
      )}
    </header>
  );
}

/** Validity, counts, and the toggle of the problems drawer. */
export function StatusBar(props: { problemsOpen: boolean; onToggleProblems: () => void }) {
  const { flow, messages, issues } = useEditor();
  const connections = edgeViews(flow, messages).length;
  return (
    <footer className="paraf-status">
      {issues.length === 0 ? (
        <span className="paraf-status__valid">
          <CheckIcon size={14} />
          {messages.flowValid}
        </span>
      ) : (
        <button
          type="button"
          className="paraf-status__invalid"
          aria-expanded={props.problemsOpen}
          onClick={props.onToggleProblems}
        >
          <AlertIcon size={14} />
          {messages.problemCount(issues.length)}
        </button>
      )}
      <span>{messages.counts(Object.keys(flow.nodes).length, connections)}</span>
    </footer>
  );
}

/** Numbered validation issues; "Show" selects and centers the node. */
export function ProblemsDrawer() {
  const { flow, issues, messages, select } = useEditor();
  const { fitView } = useReactFlow();
  return (
    <section className="paraf-problems" aria-label={messages.problems}>
      <div className="paraf-problems__head">
        <h2>{messages.problems}</h2>
        <span className="paraf-badge paraf-badge--danger">
          {messages.problemCount(issues.length)}
        </span>
        <span className="paraf-hint">{messages.problemsHint}</span>
      </div>
      <ul>
        {issues.map((issue, index) => {
          const nodeId =
            issue.nodeId !== undefined && issue.nodeId in flow.nodes ? issue.nodeId : null;
          const node = nodeId === null ? undefined : flow.nodes[nodeId];
          return (
            <li key={index}>
              <span className="paraf-number">{index + 1}</span>
              <span className="paraf-problems__text">
                {node && <b>{node.label ?? nodeId}</b>}
                <span>{issue.message.replace(/^(Flow|Node "[^"]*"(, group "[^"]*")?): /, '')}</span>
                <code>{issue.code}</code>
              </span>
              {nodeId !== null && (
                <button
                  type="button"
                  className="paraf-button"
                  onClick={() => {
                    select(nodeId);
                    void fitView({
                      nodes: [{ id: nodeId }],
                      padding: 1,
                      maxZoom: 1,
                      duration: 200,
                    });
                  }}
                >
                  {messages.show}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Confirms publishing: changes since the active version, release notes, validation. */
export function PublishDialog(props: { publish: EditorPublishOptions; onClose: () => void }) {
  const { flow, messages } = useEditor();
  const { publish } = props;
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const active = publish.activeVersion ?? null;
  const version = nextVersion(publish);
  const changes = publish.activeFlow ? diffFlows(publish.activeFlow, flow, messages) : null;
  const connections = edgeViews(flow, messages).length;

  useEffect(() => {
    dialog.current?.querySelector('textarea')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [props]);

  return (
    <div className="paraf-overlay">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paraf-publish-title"
        className="paraf-dialog"
      >
        <div className="paraf-dialog__head">
          <h2 id="paraf-publish-title">{messages.publishTitle(version)}</h2>
          <span className="paraf-hint">
            {flow.name} · <span className="paraf-mono">{flow.id}</span>
          </span>
        </div>
        <div className="paraf-dialog__body">
          {publish.target && (
            <div className="paraf-callout paraf-callout--warning">
              <AlertIcon size={18} />
              <span>{messages.publishTarget(publish.target)}</span>
            </div>
          )}
          {active !== null && publish.runningInstances !== undefined && (
            <div className="paraf-callout paraf-callout--info">
              <InfoIcon size={18} />
              <span>{messages.runningInstances(publish.runningInstances, version)}</span>
            </div>
          )}
          <div className="paraf-stack">
            <span className="paraf-strong">
              {neverPublished(publish)
                ? messages.firstVersion
                : active !== null && messages.changesSince(active)}
            </span>
            {changes && (
              <ul className="paraf-changes">
                {changes.length === 0 && <li>{messages.noChanges}</li>}
                {changes.map((change, index) => (
                  <li key={index}>
                    <span className={`paraf-changes__kind paraf-changes__kind--${change.kind}`}>
                      {messages.changeKinds[change.kind]}
                    </span>
                    <span>{change.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className="paraf-field">
            <span className="paraf-field__label">{messages.releaseNotes}</span>
            <textarea
              rows={3}
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
            />
          </label>
          <div className="paraf-callout paraf-callout--success">
            <span className="paraf-strong">
              <CheckIcon size={14} /> {messages.validationPassed}
            </span>
            <span>{messages.counts(Object.keys(flow.nodes).length, connections)}</span>
          </div>
          {error && (
            <span className="paraf-error" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="paraf-dialog__foot">
          <button type="button" className="paraf-button" onClick={props.onClose}>
            {messages.cancel}
          </button>
          <button
            type="button"
            className="paraf-button paraf-button--primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              Promise.resolve(publish.onPublish(flow, notes))
                .then(() => {
                  props.onClose();
                })
                .catch((caught: unknown) => {
                  setError(
                    messages.publishFailed(
                      caught instanceof Error ? caught.message : String(caught),
                    ),
                  );
                  setBusy(false);
                });
            }}
          >
            {messages.publishVersion(version)}
          </button>
        </div>
      </section>
    </div>
  );
}
