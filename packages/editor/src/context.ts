import { createContext, useContext } from 'react';
import type { ApproverTypeInfo, ChainInfo, FlowDefinition, FlowValidationIssue } from '@paraf/core';
import type { Messages } from './messages';

/** Shared state of one editor instance. */
export interface EditorState {
  flow: FlowDefinition;
  /**
   * Applies an edit. Edits with the same `coalesce` key in quick succession (typing in one
   * field) become a single undo step.
   */
  commit: (next: FlowDefinition, coalesce?: string) => void;
  messages: Messages;
  approverTypes: readonly ApproverTypeInfo[];
  chains: readonly ChainInfo[];
  readOnly: boolean;
  issues: readonly FlowValidationIssue[];
  selectedNodeId: string | null;
  select: (nodeId: string | null) => void;
}

export const EditorContext = createContext<EditorState | null>(null);

export function useEditor(): EditorState {
  const state = useContext(EditorContext);
  if (!state) throw new Error('Paraf: editor components must be used inside <ParafEditor>.');
  return state;
}

/** Returns `node` with `changes` applied; `undefined` values remove the key. */
export function patchNode<T extends object>(node: T, changes: Record<string, unknown>): T {
  const next = { ...node } as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) Reflect.deleteProperty(next, key);
    else next[key] = value;
  }
  return next as T;
}
