import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { FlowDefinition } from '@paraf/core';
import { defaultMessages } from '../src';
import { clickConnect, dragNode, panel, renderEditor, selectNode, targetHandle } from './harness';
import { approverTypes, specFlow } from './fixtures';

const emptyFlow = (): FlowDefinition => ({
  id: 'purchase-request',
  name: '',
  start: '',
  nodes: {},
});

describe('ParafEditor', () => {
  it('draws the flow with summaries, edges and a valid status', async () => {
    const onValidate = vi.fn();
    await renderEditor(specFlow(), { onValidate });
    const supervisor = screen.getByTestId('node-supervisor');
    expect(supervisor).toHaveTextContent('Atasan Langsung');
    expect(supervisor).toHaveTextContent('Supervisor (level 1) · any 1');
    expect(supervisor).toHaveTextContent('Timeout 3 days → escalate');
    expect(screen.getByTestId('node-chain')).toHaveTextContent(
      'Reporting line · stops at role: director',
    );
    const review = screen.getByTestId('node-review');
    expect(review).toHaveTextContent('Approval · 2 parallel groups');
    expect(review).toHaveTextContent('Financeat least 2');
    expect(review).toHaveTextContent('All groups must be satisfied');
    expect(screen.getByTestId('node-end_rejected')).toHaveClass('paraf-node--rejected');
    expect(screen.getByText('Flow is valid')).toBeInTheDocument();
    expect(screen.getByText('6 nodes · 8 connections')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(9);
    });
    expect(screen.getByText('amount > 10,000,000')).toBeInTheDocument();
    expect(onValidate).toHaveBeenCalledWith([]);
    // The palette lists the registered approver types.
    expect(within(screen.getByRole('navigation')).getByText('Manager')).toBeInTheDocument();
  });

  it('lists problems, numbers them on the cards, and shows a node', async () => {
    const flow = specFlow();
    flow.nodes.review = { ...flow.nodes.review, next: 'nowhere' } as never;
    Reflect.deleteProperty(flow.nodes.checkAmount as object, 'else');
    const { user } = await renderEditor(flow);
    const toggle = screen.getByRole('button', { name: '3 problems' });
    await user.click(toggle);
    const drawer = screen.getByRole('region', { name: 'Problems' });
    expect(within(drawer).getAllByRole('listitem')).toHaveLength(3);
    expect(
      within(screen.getByTestId('node-checkAmount')).getByLabelText(/Problems \d/),
    ).toBeInTheDocument();
    await user.click(within(drawer).getAllByRole('button', { name: 'Show' })[0] as HTMLElement);
    expect(panel().getByRole('textbox', { name: 'Node ID' })).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByRole('region', { name: 'Problems' })).not.toBeInTheDocument();
  });

  it('undoes and redoes edits with the buttons and the keyboard', async () => {
    const { user, last } = await renderEditor(specFlow());
    const undo = screen.getByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(undo).toBeDisabled();
    await user.type(panel().getByLabelText('Flow name'), '!');
    expect(last().name).toBe('Pengajuan Pembelian!');
    await user.click(undo);
    expect(last().name).toBe('Pengajuan Pembelian');
    await user.click(redo);
    expect(last().name).toBe('Pengajuan Pembelian!');

    const canvas = screen.getByRole('main', { name: 'Flow canvas' });
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    expect(last().name).toBe('Pengajuan Pembelian');
    fireEvent.keyDown(canvas, { key: 'y', ctrlKey: true });
    expect(last().name).toBe('Pengajuan Pembelian!');
    fireEvent.keyDown(canvas, { key: 'Z', metaKey: true, shiftKey: false });
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(last().name).toBe('Pengajuan Pembelian!');
    // Ignored: without a modifier, inside inputs, and with nothing left to undo.
    const count = (): number => document.querySelectorAll('.react-flow__node').length;
    fireEvent.keyDown(canvas, { key: 'z' });
    fireEvent.keyDown(panel().getByLabelText('Flow name'), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(canvas, { key: 'x', ctrlKey: true });
    expect(last().name).toBe('Pengajuan Pembelian!');
    expect(count()).toBe(7);
    await user.click(undo);
    await user.click(undo);
    expect(undo).toBeDisabled();
  });

  it('coalesces typing into one undo step', async () => {
    const { user, changes } = await renderEditor(specFlow());
    await user.type(panel().getByLabelText('Flow name'), 'abc');
    expect(changes).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(changes[changes.length - 1]?.name).toBe('Pengajuan Pembelian');
  });

  it('exports the flow as JSON', async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob);
      return 'blob:flow';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('purchase-request.json');
    });
    const { user } = await renderEditor(specFlow());
    await user.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(click).toHaveBeenCalled();
    expect(JSON.parse(await (created[0] as Blob).text())).toEqual(specFlow());
    expect(revoke).toHaveBeenCalledWith('blob:flow');
    createObjectURL.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });

  it('imports a flow file and reports broken files', async () => {
    const { last } = await renderEditor(emptyFlow());
    const input = screen.getByTestId('paraf-import');
    const upload = (text: string) => {
      fireEvent.change(input, {
        target: { files: [new File([text], 'flow.json', { type: 'application/json' })] },
      });
    };
    upload('not json');
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Import failed/);
    upload('[1]');
    expect(await screen.findByText(/not a JSON object/)).toBeInTheDocument();
    upload('{"nodes": []}');
    expect(await screen.findByText(/"nodes" must be an object/)).toBeInTheDocument();
    upload(JSON.stringify(specFlow()));
    expect(await screen.findByTestId('node-review')).toBeInTheDocument();
    expect(last()).toEqual(specFlow());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { files: [] } });
  });

  it('is read-only on request', async () => {
    await renderEditor(specFlow(), { readOnly: true, publish: { onPublish: vi.fn() } });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tidy up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add next node' })).not.toBeInTheDocument();
    expect(panel().getByLabelText('Flow name')).toBeDisabled();
    expect(document.querySelector('.paraf-editor--readonly')).not.toBeNull();
    const canvas = screen.getByRole('main', { name: 'Flow canvas' });
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
  });

  it('uses message overrides, className and style', async () => {
    await renderEditor(specFlow(), {
      messages: { flowValid: 'Alur valid', exportJson: 'Ekspor JSON' },
      className: 'mine',
      style: { height: 500 },
    });
    expect(screen.getByText('Alur valid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ekspor JSON' })).toBeInTheDocument();
    expect(document.querySelector('.paraf-editor.mine')).toHaveStyle({ height: '500px' });
    expect(defaultMessages.flowValid).toBe('Flow is valid');
  });

  it('works without registered approver types or chains', async () => {
    const { user, last } = await renderEditor(emptyFlow(), {
      approverTypes: undefined,
      chains: undefined,
    });
    await user.click(screen.getByRole('button', { name: /^Approval chain/ }));
    expect(last().nodes.approval_chain_1 ?? Object.values(last().nodes)[0]).not.toHaveProperty(
      'chain',
    );
    expect(screen.queryByText('Registered approver types')).not.toBeInTheDocument();
  });
});

describe('canvas', () => {
  it('starts an empty flow from the Start "+" or a template', async () => {
    const { user, last } = await renderEditor(emptyFlow());
    expect(screen.getByText('This flow is empty')).toBeInTheDocument();
    await user.click(
      within(screen.getByTestId('node-start')).getByRole('button', { name: 'Add next node' }),
    );
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
    await user.click(within(menu).getByRole('menuitem', { name: /^Condition/ }));
    const id = last().start;
    expect(last().nodes[id]).toEqual({ type: 'condition', label: expect.any(String), rules: [] });
    expect(panel().getByRole('textbox', { name: 'Node ID' })).toHaveValue(id);
  });

  it('applies templates', async () => {
    const { user, last } = await renderEditor({
      ...emptyFlow(),
      name: 'Named',
      variables: [{ key: 'a', type: 'text' }],
    });
    expect(document.querySelectorAll('.paraf-steps__mark--done')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /^By amount/ }));
    expect(last().start).toBe('check_amount');
    expect(last().nodes.high_amount).toMatchObject({
      approvers: [{ type: approverTypes[0]?.type }],
    });
  });

  it('applies templates with the built-in user type when nothing is registered', async () => {
    const { user, last } = await renderEditor(emptyFlow(), { approverTypes: [] });
    await user.click(screen.getByRole('button', { name: /^Single level/ }));
    expect(last().nodes.approval).toMatchObject({ approvers: [{ type: 'user' }] });
  });

  it('adds the next node below a node with +', async () => {
    const flow = specFlow();
    Reflect.deleteProperty(flow.nodes.review as object, 'next');
    flow.layout = { review: { x: 100, y: 100 } };
    const { user, last } = await renderEditor(flow);
    await user.click(
      within(screen.getByTestId('node-review')).getByRole('button', { name: 'Add next node' }),
    );
    expect(
      screen.getByRole('menu', { name: 'Add after "Manager & Finance (paralel)"' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /^End/ }));
    expect(last().nodes.review).toMatchObject({ next: 'end_1' });
    expect(last().layout?.end_1).toEqual({ x: 140, y: 290 });
    // The menu closes on Escape and on outside clicks.
    const conditionAdd = within(screen.getByTestId('node-checkAmount'));
    expect(conditionAdd.queryByRole('button', { name: 'Add next node' })).not.toBeInTheDocument();
  });

  it('closes menus with Escape or a click outside', async () => {
    const { user } = await renderEditor(emptyFlow());
    const plus = within(screen.getByTestId('node-start')).getByRole('button', {
      name: 'Add next node',
    });
    await user.click(plus);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(plus);
    await user.click(screen.getByText('This flow is empty'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(plus);
    await user.click(plus);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('adds nodes from the palette, by click or by drop', async () => {
    const { user, last } = await renderEditor(specFlow());
    await user.click(screen.getByRole('button', { name: /^Approval chain/ }));
    expect(last().nodes.chain_1).toEqual({
      type: 'approval-chain',
      label: expect.any(String),
      chain: 'supervisor',
      maxLevels: 5,
    });
    expect(last().start).toBe('supervisor');

    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };
    fireEvent.dragStart(screen.getByRole('button', { name: /^Condition/ }), { dataTransfer });
    const canvas = screen.getByRole('main', { name: 'Flow canvas' });
    fireEvent.dragOver(canvas, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('move');
    fireEvent.drop(canvas, { dataTransfer, clientX: 300, clientY: 200 });
    expect(last().nodes.condition_1).toMatchObject({ type: 'condition' });
    const before = last();
    fireEvent.drop(canvas, { dataTransfer: { getData: () => '' } });
    expect(last()).toBe(before);
  });

  it('selects nodes and deletes them with the keyboard', async () => {
    const { last } = await renderEditor(specFlow());
    selectNode('chain');
    expect(screen.getByTestId('node-chain')).toHaveClass('paraf-node--selected');
    fireEvent.keyDown(document.querySelector('.react-flow__node[data-id="chain"]') as Element, {
      key: 'Delete',
    });
    await waitFor(() => {
      expect(last().nodes).not.toHaveProperty('chain');
    });
    expect(last().nodes.checkAmount).toMatchObject({ rules: [{ when: expect.anything() }] });
    expect(panel().getByLabelText('Flow name')).toBeInTheDocument();
  });

  it('deletes selected edges, including the start edge', async () => {
    const { user, last } = await renderEditor(specFlow());
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(9);
    });
    const edge = (id: string) =>
      document.querySelector(`.react-flow__edge[data-id="${id}"]`) as Element;
    await user.click(edge('supervisor:reject'));
    await waitFor(() => {
      expect(edge('supervisor:reject')).toHaveClass('selected');
    });
    fireEvent.keyDown(edge('supervisor:reject'), { key: 'Backspace' });
    fireEvent.keyUp(edge('supervisor:reject'), { key: 'Backspace' });
    await waitFor(() => {
      expect(last().nodes.supervisor).not.toHaveProperty('onReject');
    });
    await user.click(edge('__start:start'));
    fireEvent.keyDown(edge('__start:start'), { key: 'Delete' });
    await waitFor(() => {
      expect(last().start).toBe('');
    });
    expect(
      within(screen.getByTestId('node-start')).getByRole('button', { name: 'Add next node' }),
    ).toBeInTheDocument();
  });

  it('zooms and tidies up the layout', async () => {
    const { user, last } = await renderEditor(specFlow());
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    await user.click(screen.getByRole('button', { name: 'Fit view' }));
    await user.click(screen.getByRole('button', { name: 'Tidy up' }));
    expect(last().layout?.supervisor).toEqual({ x: 40, y: 120 });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  });
});

describe('canvas interactions', () => {
  it('connects handles by clicking them, including the Start pill', async () => {
    const flow = specFlow();
    flow.start = '';
    Reflect.deleteProperty(flow.nodes.checkAmount as object, 'else');
    const { last } = await renderEditor(flow);
    const handle = (id: string, name: string) =>
      screen.getByTestId(`node-${id}`).querySelector(`[data-testid="handle-${name}"]`) as Element;
    clickConnect(handle('checkAmount', 'else'), targetHandle('end_approved'));
    expect(last().nodes.checkAmount).toMatchObject({ else: 'end_approved' });
    // Clicking a handle also selects its node; the selection settles on the last node clicked.
    expect(panel().getByRole('textbox', { name: 'Node ID' })).toHaveValue('end_approved');
    const start = screen.getByTestId('node-start').querySelector('.react-flow__handle') as Element;
    clickConnect(start, targetHandle('supervisor'));
    expect(last().start).toBe('supervisor');
  });

  it('stores node positions after a drag', async () => {
    const flow = specFlow();
    flow.layout = { chain: { x: 100, y: 100 } };
    const { last } = await renderEditor(flow);
    dragNode('chain', 100, 100);
    const moved = last().layout?.chain;
    expect(moved).toBeDefined();
    expect(moved).not.toEqual({ x: 100, y: 100 });
  });

  it('keeps one selected edge at a time', async () => {
    const { user } = await renderEditor(specFlow());
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(9);
    });
    const edge = (id: string) =>
      document.querySelector(`.react-flow__edge[data-id="${id}"]`) as Element;
    await user.click(edge('supervisor:reject'));
    await user.click(edge('review:next'));
    await waitFor(() => {
      expect(edge('review:next')).toHaveClass('selected');
    });
    expect(edge('supervisor:reject')).not.toHaveClass('selected');
  });

  it('ignores drops in read-only mode', async () => {
    const { changes } = await renderEditor(specFlow(), { readOnly: true });
    const canvas = screen.getByRole('main', { name: 'Flow canvas' });
    fireEvent.drop(canvas, { dataTransfer: { getData: () => 'end' }, clientX: 10, clientY: 10 });
    expect(changes).toHaveLength(0);
    expect(screen.queryByTestId('node-end_1')).not.toBeInTheDocument();
  });

  it('adds palette nodes below the lowest node', async () => {
    const flow = specFlow();
    flow.layout = {
      supervisor: { x: 10, y: 100 },
      review: { x: 20, y: 300 },
      chain: { x: 30, y: 200 },
    };
    const { user, last } = await renderEditor(flow);
    await user.click(screen.getByRole('button', { name: /^End/ }));
    expect(last().layout?.end_1).toEqual({ x: 20, y: 490 });
  });
});

describe('header and problems', () => {
  it('names the export after the flow, or "flow" without an ID', async () => {
    const names: string[] = [];
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:flow');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const { user } = await renderEditor({ ...specFlow(), id: '' });
    await user.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(names).toEqual(['flow.json']);
    created.mockRestore();
    revoked.mockRestore();
    click.mockRestore();
  });

  it('opens the file picker from the Import button', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    const { user } = await renderEditor(specFlow());
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('lists flow-level problems without a Show button', async () => {
    const flow = specFlow();
    flow.start = '';
    Reflect.deleteProperty(flow.nodes.checkAmount as object, 'else');
    const { user } = await renderEditor(flow, { publish: { onPublish: vi.fn() } });
    expect(screen.getByText(/^Fix \d+ problems before publishing$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /problems$/ }));
    const items = within(screen.getByRole('region', { name: 'Problems' })).getAllByRole('listitem');
    const flowLevel = items.find((item) => !item.querySelector('b'));
    expect(flowLevel).toBeDefined();
    expect(within(flowLevel as HTMLElement).queryByRole('button', { name: 'Show' })).toBeNull();
    // A node without a label is named by its ID.
    expect(items.some((item) => item.querySelector('b')?.textContent === 'checkAmount')).toBe(true);
  });

  it('marks references to missing nodes in the target select', async () => {
    const flow = specFlow();
    flow.nodes.review = { ...flow.nodes.review, next: 'nowhere' } as never;
    await renderEditor(flow);
    selectNode('review');
    expect(panel().getByLabelText('Then go to')).toHaveDisplayValue('nowhere (?)');
  });
});
