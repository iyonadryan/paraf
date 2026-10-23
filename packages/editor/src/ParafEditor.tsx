import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { validateFlow } from '@paraf/core';
import type { ApproverTypeInfo, ChainInfo, FlowDefinition, FlowValidationIssue } from '@paraf/core';
import { Canvas } from './components/Canvas';
import { Header, Palette, ProblemsDrawer, PublishDialog, StatusBar } from './components/Chrome';
import type { EditorPublishOptions } from './components/Chrome';
import { PropertiesPanel } from './components/NodePanels';
import { EditorContext } from './context';
import type { EditorState } from './context';
import { resolveMessages } from './messages';
import type { Messages } from './messages';
import { useHistory } from './useHistory';

/** Props of {@link ParafEditor}. */
export interface ParafEditorProps {
  /** The flow being edited. The editor is controlled: it never stores the flow itself. */
  value: FlowDefinition;
  /** Called with the new flow after every edit. */
  onChange: (value: FlowDefinition) => void;
  /**
   * Approver types with their configuration forms (`engine.getApproverTypes()`). Also checked
   * by validation; the built-in `user` and `field` are always available.
   */
  approverTypes?: readonly ApproverTypeInfo[];
  /** Chains for approval-chain nodes (`engine.getChains()`). */
  chains?: readonly ChainInfo[];
  /** Custom condition operators registered on the engine, so validation accepts them. */
  operators?: readonly string[];
  /** Show the flow without allowing changes. */
  readOnly?: boolean;
  /** Called whenever the validation result changes. */
  onValidate?: (issues: FlowValidationIssue[]) => void;
  /** Adds the Publish button, version badges, and the publish dialog. */
  publish?: EditorPublishOptions;
  /** Rendered at the start of the header (e.g. your logo and breadcrumbs). */
  headerStart?: ReactNode;
  /** Texts to replace (e.g. a translation); missing keys use English defaults. */
  messages?: Partial<Messages>;
  className?: string;
  style?: CSSProperties;
}

const EMPTY: readonly never[] = [];

function isTextInput(target: EventTarget): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select') !== null;
}

/**
 * Visual editor for Paraf flows: drag nodes from the palette (or press + below a node),
 * connect them, and edit their settings in the side panel, with live validation.
 *
 * Import `@paraf/editor/style.css` once in your app. The editor fills its container, so give
 * the container a height. It uses IBM Plex Sans/Mono when your page loads them.
 */
export function ParafEditor(props: ParafEditorProps) {
  const { value, onChange, onValidate, readOnly = false, publish } = props;
  const approverTypes = props.approverTypes ?? EMPTY;
  const chains = props.chains ?? EMPTY;
  const messages = useMemo(() => resolveMessages(props.messages), [props.messages]);
  const history = useHistory(value, onChange);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const issues = useMemo(
    () =>
      validateFlow(value, {
        ...(props.approverTypes ? { approverTypes: approverTypes.map((type) => type.type) } : {}),
        ...(props.chains ? { chains: chains.map((chain) => chain.name) } : {}),
        operators: props.operators ?? [],
      }),
    [value, props.approverTypes, props.chains, props.operators, approverTypes, chains],
  );
  useEffect(() => {
    onValidate?.(issues);
  }, [issues, onValidate]);

  const state: EditorState = {
    flow: value,
    commit: readOnly ? () => undefined : history.commit,
    messages,
    approverTypes,
    chains,
    readOnly,
    issues,
    selectedNodeId:
      selectedNodeId !== null && selectedNodeId in value.nodes ? selectedNodeId : null,
    select: setSelectedNodeId,
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (readOnly || isTextInput(event.target) || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      history.undo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      history.redo();
    }
  };

  const classes = ['paraf-editor'];
  if (readOnly) classes.push('paraf-editor--readonly');
  if (props.className) classes.push(props.className);

  return (
    <EditorContext.Provider value={state}>
      <ReactFlowProvider>
        <div className={classes.join(' ')} style={props.style} onKeyDown={onKeyDown}>
          <Header
            history={history}
            publish={publish}
            start={props.headerStart}
            onPublishClick={() => {
              setPublishing(true);
            }}
          />
          <div className="paraf-editor__body">
            {!readOnly && <Palette />}
            <Canvas />
            <PropertiesPanel />
          </div>
          {problemsOpen && issues.length > 0 && <ProblemsDrawer />}
          <StatusBar
            problemsOpen={problemsOpen}
            onToggleProblems={() => {
              setProblemsOpen(!problemsOpen);
            }}
          />
          {publishing && publish && (
            <PublishDialog
              publish={publish}
              onClose={() => {
                setPublishing(false);
              }}
            />
          )}
        </div>
      </ReactFlowProvider>
    </EditorContext.Provider>
  );
}
