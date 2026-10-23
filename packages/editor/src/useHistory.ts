import { useCallback, useRef, useState } from 'react';
import type { FlowDefinition } from '@paraf/core';

const LIMIT = 200;
const COALESCE_MS = 1000;

/** Undo/redo for a controlled value: remembers values passed to `onChange`. */
export function useHistory(value: FlowDefinition, onChange: (value: FlowDefinition) => void) {
  const past = useRef<FlowDefinition[]>([]);
  const future = useRef<FlowDefinition[]>([]);
  const last = useRef<{ key: string; at: number } | null>(null);
  const [, setVersion] = useState(0);
  const refresh = () => {
    setVersion((version) => version + 1);
  };

  const commit = useCallback(
    (next: FlowDefinition, coalesce?: string) => {
      const now = Date.now();
      const merge =
        coalesce !== undefined &&
        last.current?.key === coalesce &&
        now - last.current.at < COALESCE_MS;
      if (!merge) {
        past.current.push(value);
        if (past.current.length > LIMIT) past.current.shift();
      }
      last.current = coalesce === undefined ? null : { key: coalesce, at: now };
      future.current = [];
      onChange(next);
      refresh();
    },
    [value, onChange],
  );

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(value);
    last.current = null;
    onChange(previous);
    refresh();
  }, [value, onChange]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(value);
    last.current = null;
    onChange(next);
    refresh();
  }, [value, onChange]);

  return {
    commit,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
