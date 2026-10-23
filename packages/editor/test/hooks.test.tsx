import { act, renderHook } from '@testing-library/react';
import type { FlowDefinition } from '@paraf/core';
import { useEditor } from '../src/context';
import { defaultMessages as m } from '../src/messages';
import { useHistory } from '../src/useHistory';

const flow = (name: string): FlowDefinition => ({ id: 'f', name, start: '', nodes: {} });

describe('useHistory', () => {
  it('does nothing when there is nothing to undo or redo', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useHistory(flow('a'), onChange));
    act(() => {
      result.current.undo();
      result.current.redo();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('keeps the last 200 steps', () => {
    let value = flow('0');
    const { result, rerender } = renderHook(() =>
      useHistory(value, (next) => {
        value = next;
      }),
    );
    for (let n = 1; n <= 201; n++) {
      act(() => {
        result.current.commit(flow(String(n)));
      });
      rerender();
    }
    for (let n = 0; n < 200; n++) {
      act(() => {
        result.current.undo();
      });
      rerender();
    }
    // Step "0" fell off the end.
    expect(value.name).toBe('1');
    expect(result.current.canUndo).toBe(false);
  });
});

describe('useEditor', () => {
  it('requires the editor around it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useEditor())).toThrow(/must be used inside <ParafEditor>/);
    vi.restoreAllMocks();
  });
});

describe('default messages', () => {
  it('uses the singular for one', () => {
    expect(m.fixBeforePublishing(1)).toBe('Fix 1 problem before publishing');
    expect(m.counts(1, 1)).toBe('1 node · 1 connection');
    expect(m.runningInstances(1, 3)).toBe(
      '1 document in progress keeps the version it started with. Only new submissions use v3.',
    );
  });
});
