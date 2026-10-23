import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FlowDefinition } from '@paraf/core';
import { ParafEditor } from '../src';
import type { ParafEditorProps } from '../src';
import { approverTypes, chains } from './fixtures';

/** Renders a controlled editor and records every flow it emits; resolves once nodes are measured. */
export async function renderEditor(initial: FlowDefinition, props: Partial<ParafEditorProps> = {}) {
  const changes: FlowDefinition[] = [];
  function Harness() {
    const [flow, setFlow] = useState(initial);
    return (
      <div style={{ width: 1200, height: 800 }}>
        <ParafEditor
          value={flow}
          onChange={(next) => {
            changes.push(next);
            setFlow(next);
          }}
          approverTypes={approverTypes}
          chains={chains}
          {...props}
        />
      </div>
    );
  }
  // The stylesheet (not loaded in jsdom) lets the Start pill and the empty state take clicks.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  render(<Harness />);
  await waitFor(() => {
    expect(document.querySelector('.react-flow__node[style*="visibility: hidden"]')).toBeNull();
  });
  const last = (): FlowDefinition => {
    const flow = changes[changes.length - 1];
    if (!flow) throw new Error('no change yet');
    return flow;
  };
  return { user, changes, last };
}

/** Queries inside the side panel. */
export const panel = () => within(screen.getByRole('complementary'));

/**
 * Opens a node in the side panel by clicking its card. A plain click: the mousedown of a full
 * pointer sequence starts d3-drag, which needs a real window on the event.
 */
export function selectNode(id: string) {
  fireEvent.click(screen.getByTestId(`node-${id}`));
  expect(panel().getByRole('textbox', { name: 'Node ID' })).toHaveValue(id);
}

/**
 * Drags a canvas node by (dx, dy). d3-drag reads `event.view`, which jsdom only accepts as its
 * own window object, so it is set on the event afterwards.
 */
export function dragNode(id: string, dx: number, dy: number) {
  const node = document.querySelector(`.react-flow__node[data-id="${id}"]`) as Element;
  const mouse = (target: EventTarget, type: string, x: number, y: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    Object.defineProperty(event, 'view', { value: window });
    act(() => {
      target.dispatchEvent(event);
    });
  };
  mouse(node, 'mousedown', 100, 100);
  mouse(window, 'mousemove', 100 + dx / 2, 100 + dy / 2);
  mouse(window, 'mousemove', 100 + dx, 100 + dy);
  mouse(window, 'mouseup', 100 + dx, 100 + dy);
}

/** Connects two handles the way React Flow's click-to-connect does: one click on each. */
export function clickConnect(from: Element, to: Element) {
  fireEvent.click(from);
  fireEvent.click(to);
}

/** The target handle (top) of a card. */
export const targetHandle = (id: string) =>
  screen.getByTestId(`node-${id}`).querySelector('.react-flow__handle-top') as Element;
