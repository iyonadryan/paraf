import { act, fireEvent, screen, within } from '@testing-library/react';
import type { ApproverTypeInfo, FlowDefinition } from '@paraf/core';
import { panel, renderEditor, selectNode } from './harness';
import { specFlow } from './fixtures';

const node = (flow: FlowDefinition, id: string) =>
  flow.nodes[id] as unknown as Record<string, unknown>;

describe('node head and actions', () => {
  it('renames nodes, rejecting invalid or taken IDs', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('review');
    const id = panel().getByRole('textbox', { name: 'Node ID' });
    await user.clear(id);
    await user.type(id, 'bad id{Enter}');
    expect(panel().getByRole('alert')).toHaveTextContent('Use letters, digits');
    await user.clear(id);
    await user.type(id, 'chain');
    expect(panel().queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.blur(id);
    expect(panel().getByRole('alert')).toHaveTextContent('Another node already uses this ID.');
    await user.clear(id);
    await user.type(id, 'final{Enter}');
    expect(last().nodes).toHaveProperty('final');
    expect(node(last(), 'chain').next).toBe('final');
    expect(panel().getByRole('textbox', { name: 'Node ID' })).toHaveValue('final');
    fireEvent.blur(panel().getByRole('textbox', { name: 'Node ID' }));
  });

  it('edits and clears the label, sets the start node, and deletes nodes', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('chain');
    const label = panel().getByLabelText('Label');
    await user.clear(label);
    expect(node(last(), 'chain')).not.toHaveProperty('label');
    await user.type(label, 'Up');
    expect(node(last(), 'chain').label).toBe('Up');
    await user.click(panel().getByRole('button', { name: 'Set as start' }));
    expect(last().start).toBe('chain');
    expect(panel().getByText('Start')).toBeInTheDocument();
    await user.click(panel().getByRole('button', { name: 'Delete node' }));
    expect(last().nodes).not.toHaveProperty('chain');
    expect(panel().getByLabelText('Flow name')).toBeInTheDocument();
  });
});

describe('approval panel', () => {
  it('edits approvers and their rules', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('supervisor');
    const approvers = panel().getByRole('group', { name: 'Approvers' });
    const level = within(approvers).getByLabelText('Level');
    await user.clear(level);
    expect(node(last(), 'supervisor').approvers).toEqual([{ type: 'supervisor' }]);
    await user.type(level, '3');
    expect(node(last(), 'supervisor').approvers).toEqual([{ type: 'supervisor', level: 3 }]);

    const mode = panel().getByRole('group', { name: 'How many must approve' });
    await user.click(within(mode).getByRole('button', { name: 'All' }));
    expect(node(last(), 'supervisor').mode).toBe('all');
    await user.click(within(mode).getByRole('button', { name: 'All' }));
    await user.click(within(mode).getByRole('button', { name: 'At least n' }));
    expect(node(last(), 'supervisor').mode).toEqual({ minimum: 2 });
    const n = panel().getByLabelText('n');
    await user.clear(n);
    expect(node(last(), 'supervisor').mode).toEqual({ minimum: 1 });
    await user.type(n, '4');
    expect(node(last(), 'supervisor').mode).toEqual({ minimum: 14 });

    await user.selectOptions(panel().getByLabelText('Rejected when'), 'n people reject');
    expect(node(last(), 'supervisor').rejectPolicy).toEqual({ minimum: 1 });
    const rejections = panel().getByLabelText('Rejections');
    await user.clear(rejections);
    await user.type(rejections, '2');
    expect(node(last(), 'supervisor').rejectPolicy).toEqual({ minimum: 12 });
    await user.selectOptions(
      panel().getByLabelText('Rejected when'),
      'The minimum can no longer be reached (default)',
    );
    expect(node(last(), 'supervisor')).not.toHaveProperty('rejectPolicy');

    await user.selectOptions(
      panel().getByLabelText('If there are fewer than n approvers'),
      'Add fallback approvers',
    );
    expect(node(last(), 'supervisor').onInsufficientApprovers).toBe('fallback');
    const fallback = panel().getByRole('group', { name: 'Fallback approvers' });
    await user.click(within(fallback).getByRole('button', { name: '+ Add approver source' }));
    await user.click(screen.getByRole('menuitem', { name: /^Specific users/ }));
    const users = within(fallback).getByLabelText('Users');
    await user.type(users, 'u1');
    expect(node(last(), 'supervisor').fallbackApprovers).toEqual([{ type: 'user', value: 'u1' }]);
    await user.type(users, ', u2');
    expect(node(last(), 'supervisor').fallbackApprovers).toEqual([
      { type: 'user', value: ['u1', 'u2'] },
    ]);
    await user.clear(users);
    expect(node(last(), 'supervisor').fallbackApprovers).toEqual([{ type: 'user' }]);
    await user.click(within(fallback).getByRole('button', { name: 'Remove Specific users' }));
    expect(node(last(), 'supervisor').fallbackApprovers).toEqual([]);

    await user.click(within(approvers).getByRole('button', { name: 'Remove Manager' }));
    expect(node(last(), 'supervisor').approvers).toEqual([]);
    expect(panel().getByText(/Choose who approves at this step/)).toBeInTheDocument();
  });

  it('edits advanced settings, the timeout and the connections', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('supervisor');
    await user.click(panel().getByRole('checkbox', { name: /^Exclude the requester/ }));
    expect(node(last(), 'supervisor').excludeRequester).toBe(false);
    await user.selectOptions(
      panel().getByLabelText('Approvers who already approved at an earlier level'),
      'Auto-approve',
    );
    expect(node(last(), 'supervisor').duplicateApprover).toBe('auto-approve');
    await user.selectOptions(
      panel().getByLabelText('If nobody is found'),
      'Use fallback approvers',
    );
    expect(panel().getByRole('group', { name: 'Fallback approvers' })).toBeInTheDocument();

    const after = panel().getByLabelText('After');
    await user.clear(after);
    await user.type(after, 'PT12H');
    expect(node(last(), 'supervisor').timeout).toEqual({
      after: 'PT12H',
      action: 'escalate',
      to: [{ type: 'supervisor', level: 2 }],
    });
    const escalate = panel().getByRole('group', { name: 'Escalate to' });
    await user.click(within(escalate).getByRole('button', { name: 'Remove Manager' }));
    expect((node(last(), 'supervisor').timeout as { to: unknown[] }).to).toEqual([]);
    const timeout = panel().getByRole('checkbox', { name: /^Escalate after a timeout/ });
    await user.click(timeout);
    expect(node(last(), 'supervisor')).not.toHaveProperty('timeout');
    await user.click(timeout);
    expect(node(last(), 'supervisor').timeout).toEqual({
      after: 'P3D',
      action: 'escalate',
      to: [],
    });

    await user.selectOptions(panel().getByLabelText('Then go to'), 'end_approved');
    expect(node(last(), 'supervisor').next).toBe('end_approved');
    await user.selectOptions(panel().getByLabelText('If rejected, go to'), '—');
    expect(node(last(), 'supervisor')).not.toHaveProperty('onReject');
    expect(
      within(panel().getByLabelText('Then go to')).queryByRole('option', { name: /supervisor/ }),
    ).toBeNull();
  });

  it('splits into parallel groups and merges them back', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('supervisor');
    await user.click(panel().getByRole('button', { name: 'Split into parallel groups' }));
    expect(node(last(), 'supervisor').groups).toEqual([
      {
        id: 'group_1',
        approvers: [{ type: 'supervisor', level: 1 }],
        mode: 'any',
        excludeRequester: true,
        onEmptyApprovers: 'skip',
      },
    ]);
    expect(node(last(), 'supervisor')).not.toHaveProperty('approvers');
    await user.click(panel().getByRole('button', { name: 'Merge into one group' }));
    expect(node(last(), 'supervisor')).toEqual(specFlow().nodes.supervisor);
  });

  it('merges an approval node without groups left', async () => {
    const flow = specFlow();
    flow.nodes.review = {
      type: 'approval',
      groups: [],
      require: 'any',
      countAcrossGroups: false,
    } as never;
    const { user, last } = await renderEditor(flow);
    selectNode('review');
    await user.click(panel().getByRole('button', { name: 'Merge into one group' }));
    expect(node(last(), 'review')).toEqual({ type: 'approval', approvers: [], mode: 'any' });
  });

  it('edits, reorders, adds and removes groups', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('review');
    const groups = () => node(last(), 'review').groups as { id: string; label?: string }[];
    const finance = panel().getByRole('group', { name: 'Finance' });
    expect(within(finance).getByRole('checkbox', { name: 'finance' })).toBeChecked();
    expect(within(finance).getByLabelText('If there are fewer than n approvers')).toHaveValue(
      'cap',
    );

    await user.click(within(finance).getByRole('button', { name: 'Move up' }));
    expect(groups().map((group) => group.id)).toEqual(['fin', 'mgr']);
    await user.click(
      within(panel().getByRole('group', { name: 'Finance' })).getByRole('button', {
        name: 'Move down',
      }),
    );
    expect(groups().map((group) => group.id)).toEqual(['mgr', 'fin']);

    const manager = panel().getByRole('group', { name: 'Manager' });
    await user.clear(within(manager).getByLabelText('Group name'));
    expect(groups()[0]).not.toHaveProperty('label');
    const mgr = panel().getByRole('group', { name: 'mgr' });
    await user.type(within(mgr).getByLabelText('Group ID'), '2');
    expect(groups()[0]?.id).toBe('mgr2');
    await user.click(
      within(panel().getByRole('group', { name: 'mgr2' })).getByRole('checkbox', {
        name: 'director',
      }),
    );
    expect(groups()[0]).toMatchObject({
      approvers: [{ type: 'role', value: ['manager', 'director'] }],
    });
    await user.click(
      within(panel().getByRole('group', { name: 'mgr2' })).getByRole('checkbox', {
        name: /^Exclude the requester/,
      }),
    );
    expect(groups()[0]).toMatchObject({ excludeRequester: true });

    await user.click(panel().getByRole('button', { name: '+ Add group' }));
    expect(groups()[2]).toEqual({ id: 'group_3', approvers: [], mode: 'any' });
    await user.click(panel().getByRole('button', { name: 'Remove group_3' }));
    expect(groups()).toHaveLength(2);

    await user.selectOptions(
      panel().getByLabelText('Node completes when'),
      'At least n groups are satisfied',
    );
    expect(node(last(), 'review').require).toEqual({ minimum: 1 });
    await user.click(panel().getByRole('checkbox', { name: /^Count votes in every group/ }));
    expect(node(last(), 'review').countAcrossGroups).toBe(false);
  });

  it('adds group IDs that are not taken yet', async () => {
    const flow = specFlow();
    (flow.nodes.review as { groups: { id: string }[] }).groups[1] = { id: 'group_3' };
    const { user, last } = await renderEditor(flow);
    selectNode('review');
    await user.click(panel().getByRole('button', { name: '+ Add group' }));
    expect((node(last(), 'review').groups as { id: string }[])[2]?.id).toBe('group_4');
  });
});

describe('approver sources', () => {
  const custom: ApproverTypeInfo[] = [
    {
      type: 'team',
      label: 'Team',
      configSchema: {
        value: {
          type: 'multiselect',
          label: 'Teams',
          options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((value) => ({
            value,
            label: `Team ${value}`,
          })),
        },
        lead: { type: 'boolean', label: 'Lead only' },
        site: {
          type: 'select',
          label: 'Site',
          options: () => Promise.resolve([{ value: 'jkt', label: 'Jakarta' }]),
        },
        note: { type: 'text', label: 'Note' },
      },
    },
  ];

  it('renders every kind of config field', async () => {
    const flow = specFlow();
    flow.variables = [{ key: 'pic', type: 'user', label: 'PIC' }];
    flow.nodes.supervisor = {
      type: 'approval',
      approvers: [{ type: 'team' }, { type: 'ghost', x: 1 }, { type: 'field' }],
    } as never;
    const { user, last } = await renderEditor(flow, { approverTypes: custom });
    selectNode('supervisor');
    const approvers = () => node(last(), 'supervisor').approvers as Record<string, unknown>[];
    const search = panel().getByRole('searchbox', { name: 'Search Teams' });
    await user.type(search, 'team g');
    expect(panel().getAllByRole('checkbox', { name: /^Team / })).toHaveLength(1);
    await user.click(panel().getByRole('checkbox', { name: 'Team g' }));
    expect(approvers()[0]).toEqual({ type: 'team', value: 'g' });
    await user.click(panel().getByRole('checkbox', { name: 'Team g' }));
    expect(approvers()[0]).toEqual({ type: 'team' });

    await user.click(panel().getByRole('checkbox', { name: 'Lead only' }));
    expect(approvers()[0]).toEqual({ type: 'team', lead: true });
    await user.click(panel().getByRole('checkbox', { name: 'Lead only' }));
    expect(approvers()[0]).toEqual({ type: 'team' });

    const site = await panel().findByRole('combobox', { name: 'Site' });
    await user.selectOptions(site, 'Jakarta');
    expect(approvers()[0]).toEqual({ type: 'team', site: 'jkt' });
    await user.selectOptions(site, '—');
    expect(approvers()[0]).toEqual({ type: 'team' });

    await user.type(panel().getByLabelText('Note'), 'x');
    expect(approvers()[0]).toEqual({ type: 'team', note: 'x' });
    await user.clear(panel().getByLabelText('Note'));
    expect(approvers()[0]).toEqual({ type: 'team' });

    expect(panel().getByText(/not registered/)).toBeInTheDocument();
    expect(panel().getByText(/"x": 1/)).toBeInTheDocument();
    const variable = panel().getByLabelText('Variable');
    expect(variable).toHaveAttribute('list');
    await user.type(variable, 'pic');
    expect(approvers()[2]).toEqual({ type: 'field', value: 'pic' });
  });

  it('suggests adding a user variable for the field type', async () => {
    const flow = specFlow();
    flow.nodes.supervisor = {
      type: 'approval',
      approvers: [{ type: 'field', value: { odd: true } }],
    } as never;
    await renderEditor(flow, { approverTypes: [] });
    selectNode('supervisor');
    expect(
      panel().getByText('Add a document variable of type User to pick it here.'),
    ).toBeInTheDocument();
    expect(panel().getByLabelText('Variable')).toHaveValue('{"odd":true}');
  });
});

describe('approval chain panel', () => {
  it('edits the chain settings', async () => {
    const flow = specFlow();
    flow.variables = [{ key: 'pic', type: 'user' }];
    const { user, last } = await renderEditor(flow);
    selectNode('chain');
    const chain = () => node(last(), 'chain');
    await user.selectOptions(panel().getByLabelText('Chain'), '—');
    expect(chain()).not.toHaveProperty('chain');
    await user.selectOptions(panel().getByLabelText('Chain'), 'Reporting');
    expect(chain().chain).toBe('supervisor');

    await user.selectOptions(panel().getByLabelText('Start from'), 'A user in a document variable');
    expect(chain().from).toEqual({ field: 'pic' });
    const path = panel().getByLabelText('Variable');
    await user.type(path, '2');
    expect(chain().from).toEqual({ field: 'pic2' });
    await user.selectOptions(panel().getByLabelText('Start from'), 'The requester (default)');
    expect(chain()).not.toHaveProperty('from');

    const stop = panel().getByText('Stop at').parentElement as HTMLElement;
    await user.click(within(stop).getByRole('checkbox', { name: 'manager' }));
    expect(chain().until).toEqual({ type: 'role', value: ['director', 'manager'] });
    await user.click(within(stop).getByRole('button', { name: 'Remove Role' }));
    expect(chain()).not.toHaveProperty('until');
    await user.click(panel().getByRole('button', { name: '+ Add a stop condition' }));
    await user.click(screen.getByRole('menuitem', { name: /^Manager/ }));
    expect(chain().until).toEqual({ type: 'supervisor' });

    await user.click(panel().getByRole('checkbox', { name: /^That person approves too/ }));
    expect(chain().includeStopper).toBe(false);
    const levels = panel().getByLabelText('Maximum levels');
    await user.clear(levels);
    expect(chain()).not.toHaveProperty('maxLevels');
    await user.type(levels, '7');
    expect(chain().maxLevels).toBe(7);

    await user.selectOptions(
      panel().getByLabelText('Approvers who already approved at an earlier level'),
      'Must approve again (default)',
    );
    expect(chain()).not.toHaveProperty('duplicateApprover');
    await user.click(panel().getByRole('checkbox', { name: /^Exclude the requester/ }));
    expect(chain().excludeRequester).toBe(true);
    await user.selectOptions(
      panel().getByLabelText('If there is nobody above'),
      'Use fallback approvers',
    );
    expect(chain().onEmptyApprovers).toBe('fallback');
    const fallback = panel().getByRole('group', { name: 'Fallback approvers' });
    await user.click(within(fallback).getByRole('button', { name: '+ Add approver source' }));
    await user.click(screen.getByRole('menuitem', { name: /^Role/ }));
    expect(chain().fallbackApprovers).toEqual([{ type: 'role' }]);
    await user.click(panel().getByRole('checkbox', { name: /^Escalate after a timeout/ }));
    expect(chain().timeout).toEqual({ after: 'P3D', action: 'escalate', to: [] });
    await user.type(panel().getByLabelText('After'), 'X');
    expect(chain().timeout).toMatchObject({ after: 'P3DX' });
  });

  it('keeps an unknown chain and a field start without user variables', async () => {
    const flow = specFlow();
    flow.nodes.chain = { type: 'approval-chain', chain: 'matrix', from: { field: 'x' } } as never;
    const { user, last } = await renderEditor(flow);
    selectNode('chain');
    expect(panel().getByLabelText('Chain')).toHaveDisplayValue('matrix (?)');
    expect(panel().getByLabelText('Variable')).toHaveValue('x');
    await user.selectOptions(panel().getByLabelText('Start from'), 'The requester');
    await user.selectOptions(panel().getByLabelText('Start from'), 'A user in a document variable');
    expect(node(last(), 'chain').from).toEqual({ field: '' });
  });
});

describe('condition panel', () => {
  it('edits rules with the builder', async () => {
    const flow = specFlow();
    flow.variables = [
      { key: 'amount', type: 'number', label: 'Amount' },
      { key: 'dept', type: 'select', options: ['IT', 'HR'] },
      { key: 'urgent', type: 'boolean' },
      { key: 'due', type: 'date' },
    ];
    const { user, last } = await renderEditor(flow);
    selectNode('checkAmount');
    const rules = () => node(last(), 'checkAmount').rules as Record<string, unknown>[];
    const rule = panel().getByRole('group', { name: 'Rule 1' });
    expect(within(rule).getByRole('button', { name: 'Choose a variable' })).toHaveTextContent(
      'Amount',
    );
    expect(within(rule).queryByLabelText('Type')).not.toBeInTheDocument();
    await user.clear(within(rule).getByLabelText('Value'));
    await user.type(within(rule).getByLabelText('Value'), '5');
    expect(rules()[0]?.when).toEqual({ '>': [{ var: 'amount' }, 5] });
    await user.type(within(rule).getByLabelText('Name (optional)'), 'Big');
    expect(rules()[0]?.label).toBe('Big');
    await user.clear(within(rule).getByLabelText('Name (optional)'));
    expect(rules()[0]).not.toHaveProperty('label');

    // A second comparison on a select variable, then switch to "or".
    await user.click(within(rule).getByRole('button', { name: '+ Add condition (AND / OR)' }));
    const pickers = () =>
      within(rule).getAllByRole('button', {
        name: /Choose a variable|Amount|dept|Urgent|urgent|due/,
      });
    await user.click(pickers()[1] as HTMLElement);
    await user.click(screen.getByRole('option', { name: /dept/ }));
    expect(rules()[0]?.when).toEqual({
      and: [{ '>': [{ var: 'amount' }, 5] }, { '==': [{ var: 'dept' }, 'IT'] }],
    });
    const values = () => within(rule).getAllByLabelText('Value');
    await user.selectOptions(values()[1] as HTMLElement, 'HR');
    await user.selectOptions(within(rule).getByLabelText('and / or'), 'or');
    expect(rules()[0]?.when).toEqual({
      or: [{ '>': [{ var: 'amount' }, 5] }, { '==': [{ var: 'dept' }, 'HR'] }],
    });

    // "is one of" turns the value into a list, and back.
    const operators = () => within(rule).getAllByLabelText('Operator');
    await user.selectOptions(operators()[1] as HTMLElement, 'in');
    await user.type(values()[1] as HTMLElement, 'IT, HR');
    expect(rules()[0]?.when).toMatchObject({ or: [{}, { in: [{ var: 'dept' }, ['IT', 'HR']] }] });
    await user.selectOptions(operators()[1] as HTMLElement, '!=');
    expect(rules()[0]?.when).toMatchObject({ or: [{}, { '!=': [{ var: 'dept' }, 'IT'] }] });
    await user.selectOptions(operators()[1] as HTMLElement, '==');

    // Boolean and date variables by keyboard.
    await user.click(pickers()[1] as HTMLElement);
    const urgent = screen.getByRole('option', { name: /urgent/ });
    fireEvent.keyDown(urgent, { key: 'ArrowDown' });
    fireEvent.keyDown(urgent, { key: 'Enter' });
    expect(rules()[0]?.when).toMatchObject({ or: [{}, { '==': [{ var: 'urgent' }, true] }] });
    await user.selectOptions(values()[1] as HTMLElement, 'No');
    expect(rules()[0]?.when).toMatchObject({ or: [{}, { '==': [{ var: 'urgent' }, false] }] });
    await user.click(pickers()[1] as HTMLElement);
    await user.click(screen.getByRole('option', { name: /due/ }));
    expect(values()[1]).toHaveAttribute('type', 'date');

    // A free path with a value type of its own.
    await user.click(pickers()[1] as HTMLElement);
    const other = screen.getByLabelText('Other field');
    await user.type(other, 'items.0.price{Enter}');
    await user.selectOptions(within(rule).getByLabelText('Type'), 'number');
    expect(rules()[0]?.when).toMatchObject({ or: [{}, { '==': [{ var: 'items.0.price' }, 0] }] });
    await user.selectOptions(operators()[1] as HTMLElement, 'in');
    expect(within(within(rule).getByLabelText('Type')).getAllByRole('option')).toHaveLength(1);
    await user.selectOptions(operators()[1] as HTMLElement, '<');
    expect(rules()[0]?.when).toMatchObject({ or: [{}, { '<': [{ var: 'items.0.price' }, ''] }] });

    // Removing comparisons down to "always".
    await user.click(within(rule).getAllByRole('button', { name: 'Remove' })[1] as HTMLElement);
    await user.click(within(rule).getByRole('button', { name: 'Remove' }));
    expect(rules()[0]?.when).toBe(true);
    expect(within(rule).getByText(/Always matches/)).toBeInTheDocument();
  });

  it('picks variables for a list comparison without changing its value', async () => {
    const flow = specFlow();
    flow.variables = [
      { key: 'dept', type: 'select', options: [] },
      { key: 'amount', type: 'number' },
    ];
    (flow.nodes.checkAmount as { rules: unknown[] }).rules = [
      { when: { in: [{ var: 'x' }, ['a']] }, next: 'chain' },
    ];
    const { user, last } = await renderEditor(flow);
    selectNode('checkAmount');
    const rule = panel().getByRole('group', { name: 'Rule 1' });
    await user.click(within(rule).getByRole('button', { name: 'Choose a variable' }));
    await user.click(screen.getByRole('option', { name: /dept/ }));
    expect((node(last(), 'checkAmount').rules as { when: unknown }[])[0]?.when).toEqual({
      in: [{ var: 'dept' }, ['a']],
    });
    await user.selectOptions(within(rule).getByLabelText('Operator'), '==');
    expect(within(rule).getByLabelText('Value')).toHaveDisplayValue('');
    await user.click(within(rule).getByRole('button', { name: 'Choose a variable' }));
    await user.click(screen.getByRole('option', { name: /amount/ }));
    await user.selectOptions(within(rule).getByLabelText('Operator'), 'in');
    await user.selectOptions(within(rule).getByLabelText('Operator'), '>=');
    expect((node(last(), 'checkAmount').rules as { when: unknown }[])[0]?.when).toEqual({
      '>=': [{ var: 'amount' }, 0],
    });
  });

  it('keeps advanced expressions until replaced, and edits rules and else', async () => {
    const flow = specFlow();
    (flow.nodes.checkAmount as { rules: unknown[] }).rules = [
      { when: { '>': [{ var: 'a' }, { var: 'b' }] }, next: 'chain' },
      { when: true, next: 'review' },
    ];
    const { user, last } = await renderEditor(flow);
    selectNode('checkAmount');
    const rules = () => node(last(), 'checkAmount').rules as Record<string, unknown>[];
    expect(panel().getByText(/too complex for the builder/)).toBeInTheDocument();
    await user.click(panel().getByRole('button', { name: 'Replace with a simple rule' }));
    expect(rules()[0]?.when).toBe(true);
    await user.selectOptions(
      within(panel().getByRole('group', { name: 'Rule 2' })).getByLabelText('Go to'),
      '—',
    );
    expect(rules()[1]).toEqual({ when: true });
    await user.click(panel().getByRole('button', { name: 'Remove Rule 2' }));
    expect(rules()).toHaveLength(1);
    await user.click(panel().getByRole('button', { name: '+ Add rule' }));
    expect(rules()[1]).toEqual({ when: true });
    const otherwise = panel().getByText('Otherwise (required)').parentElement as HTMLElement;
    await user.selectOptions(within(otherwise).getByLabelText('Go to'), 'end_rejected');
    expect(node(last(), 'checkAmount').else).toBe('end_rejected');
    expect(panel().getByText('View as JSON')).toBeInTheDocument();
    await user.click(panel().getByRole('button', { name: 'Delete node' }));
    expect(last().nodes).not.toHaveProperty('checkAmount');
  });

  it('opens a condition whose rules are not a list', async () => {
    const flow = specFlow();
    flow.nodes.checkAmount = { type: 'condition', rules: 'oops', else: 'review' } as never;
    await renderEditor(flow);
    selectNode('checkAmount');
    expect(panel().queryByRole('group', { name: 'Rule 1' })).not.toBeInTheDocument();
  });
});

describe('end panel', () => {
  it('switches the result', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('end_approved');
    await user.click(panel().getByRole('button', { name: 'Rejected' }));
    expect(node(last(), 'end_approved').result).toBe('rejected');
    expect(screen.getByTestId('node-end_approved')).toHaveClass('paraf-node--rejected');
  });
});

describe('flow settings', () => {
  it('edits the flow fields', async () => {
    const { user, last } = await renderEditor(specFlow());
    await user.type(panel().getByLabelText('Flow ID'), '-v2');
    expect(last().id).toBe('purchase-request-v2');
    expect(
      panel().getByText("Used in code: engine.start('purchase-request-v2', ...)"),
    ).toBeInTheDocument();
    await user.selectOptions(panel().getByLabelText('Start node'), 'review');
    expect(last().start).toBe('review');
    await user.selectOptions(panel().getByLabelText('Start node'), '—');
    expect(last().start).toBe('');
    await user.selectOptions(
      panel().getByLabelText('When a returned document is resubmitted'),
      'Resume from the step that returned it',
    );
    expect(last().resubmitPolicy).toBe('resume');
    await user.selectOptions(
      panel().getByLabelText('When a returned document is resubmitted'),
      'Restart from the beginning (default)',
    );
    expect(last()).not.toHaveProperty('resubmitPolicy');
  });

  it('adds, edits and removes document variables', async () => {
    const { user, last } = await renderEditor(specFlow());
    await user.click(panel().getByRole('button', { name: '+ Add variable' }));
    let form = panel().getByRole('group', { name: 'Add variable' });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Use a path such as amount');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(panel().queryByRole('group', { name: 'Add variable' })).not.toBeInTheDocument();

    await user.click(panel().getByRole('button', { name: '+ Add variable' }));
    form = panel().getByRole('group', { name: 'Add variable' });
    await user.type(within(form).getByLabelText('Key'), 'amount');
    await user.type(within(form).getByLabelText('Label'), ' Amount ');
    await user.click(within(form).getByRole('checkbox', { name: 'Required on submission' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(last().variables).toEqual([
      { key: 'amount', label: 'Amount', type: 'number', required: true },
    ]);
    expect(panel().getByText('1 variable')).toBeInTheDocument();

    await user.click(panel().getByRole('button', { name: '+ Add variable' }));
    form = panel().getByRole('group', { name: 'Add variable' });
    await user.type(within(form).getByLabelText('Key'), 'amount');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Another variable already uses this key.',
    );
    await user.clear(within(form).getByLabelText('Key'));
    await user.type(within(form).getByLabelText('Key'), 'dept');
    await user.click(within(form).getByRole('button', { name: 'Select' }));
    const option = within(form).getByLabelText('+ option');
    await user.type(option, 'IT{Enter}');
    await user.type(option, 'HR');
    fireEvent.blur(option);
    await user.type(option, 'IT{Enter}');
    await user.type(option, '{Enter}');
    await user.click(within(form).getByRole('button', { name: 'Remove HR' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(last().variables?.[1]).toEqual({ key: 'dept', type: 'select', options: ['IT'] });

    await user.click(panel().getByRole('button', { name: /^dept/ }));
    form = panel().getByRole('group', { name: 'Edit variable' });
    await user.click(within(form).getByRole('button', { name: 'Text' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(last().variables?.[1]).toEqual({ key: 'dept', type: 'text' });
    expect(panel().getAllByText('Yes')).toHaveLength(1);

    await user.click(panel().getByRole('button', { name: /^dept/ }));
    await user.click(panel().getByRole('button', { name: 'Remove amount' }));
    expect(last().variables).toEqual([{ key: 'dept', type: 'text' }]);
    await user.click(panel().getByRole('button', { name: 'Remove dept' }));
    expect(last()).not.toHaveProperty('variables');
  });
});

describe('publishing', () => {
  it('publishes the first version with release notes', async () => {
    const onPublish = vi.fn();
    const { user } = await renderEditor(specFlow(), {
      publish: { activeVersion: null, onPublish },
    });
    expect(screen.getByText('draft · never published')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 1' });
    expect(within(dialog).getByText('This is the first version of the flow.')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox')).toHaveFocus();
    await user.type(within(dialog).getByRole('textbox'), 'First');
    await user.click(within(dialog).getByRole('button', { name: 'Publish v1' }));
    expect(onPublish).toHaveBeenCalledWith(specFlow(), 'First');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists changes since the active version and reports failures', async () => {
    const active = specFlow();
    active.name = 'Old';
    const onPublish = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce('down');
    const { user } = await renderEditor(specFlow(), {
      publish: { activeVersion: 2, activeFlow: active, runningInstances: 3, onPublish },
    });
    expect(screen.getByText('v3 · draft')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish v3' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/3 documents in progress keep using v2/)).toBeInTheDocument();
    expect(within(dialog).getByText('Flow: name')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Publish v3' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Publishing failed: boom');
    await user.click(within(dialog).getByRole('button', { name: 'Publish v3' }));
    expect(await within(dialog).findByText('Publishing failed: down')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish v3' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows no changes, and blocks publishing while there are problems', async () => {
    const { user } = await renderEditor(specFlow(), {
      publish: { activeVersion: 1, activeFlow: specFlow(), onPublish: vi.fn() },
    });
    await user.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(screen.getByText('No changes.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.selectOptions(panel().getByLabelText('Start node'), '—');
    expect(screen.getByRole('button', { name: 'Publish v2' })).toBeDisabled();
    expect(screen.getByText(/Fix \d+ problems? before publishing/)).toBeInTheDocument();
  });
});

describe('panel details', () => {
  it('names a group', async () => {
    const { user, last } = await renderEditor(specFlow());
    selectNode('review');
    await user.type(
      within(panel().getByRole('group', { name: 'Finance' })).getByLabelText('Group name'),
      '!',
    );
    expect((node(last(), 'review').groups as { label?: string }[])[1]?.label).toBe('Finance!');
  });

  it('closes the variable picker with Escape and offers select variables without options', async () => {
    const flow = specFlow();
    flow.variables = [{ key: 'dept', type: 'select' }];
    const { user, last } = await renderEditor(flow);
    selectNode('checkAmount');
    const rule = panel().getByRole('group', { name: 'Rule 1' });
    const picker = within(rule).getByRole('button', { name: 'Choose a variable' });
    await user.click(picker);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(picker);
    await user.click(screen.getByRole('option', { name: /dept/ }));
    expect((node(last(), 'checkAmount').rules as { when: unknown }[])[0]?.when).toEqual({
      '>': [{ var: 'dept' }, ''],
    });
    expect(within(within(rule).getByLabelText('Value')).getAllByRole('option')).toHaveLength(1);
  });

  it('saves a select variable without options', async () => {
    const { user, last } = await renderEditor(specFlow());
    await user.click(panel().getByRole('button', { name: '+ Add variable' }));
    const form = panel().getByRole('group', { name: 'Add variable' });
    await user.type(within(form).getByLabelText('Key'), 'kind');
    await user.click(within(form).getByRole('button', { name: 'Select' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(last().variables).toEqual([{ key: 'kind', type: 'select', options: [] }]);
  });

  it('handles approver types without settings, and user variables without a label', async () => {
    const types: ApproverTypeInfo[] = [{ type: 'everyone', label: 'Everyone' }];
    const flow = specFlow();
    flow.variables = [{ key: 'pic', type: 'user' }];
    flow.nodes.supervisor = {
      type: 'approval',
      approvers: [{ type: 'everyone' }, { type: 'field' }],
      mode: 'any',
    } as never;
    await renderEditor(flow, { approverTypes: types });
    selectNode('supervisor');
    const approvers = panel().getByRole('group', { name: 'Approvers' });
    expect(within(approvers).getByText('Everyone')).toBeInTheDocument();
    const list = document.getElementById(
      within(approvers).getByLabelText('Variable').getAttribute('list') as string,
    );
    expect(list?.querySelector('option')).toHaveTextContent('pic');
  });

  it('ignores options that load after the panel closed', async () => {
    let resolve: (options: { value: string; label: string }[]) => void = () => undefined;
    const types: ApproverTypeInfo[] = [
      {
        type: 'site',
        label: 'Site',
        configSchema: {
          value: {
            type: 'select',
            label: 'Site',
            options: () => new Promise((done) => (resolve = done)),
          },
        },
      },
    ];
    const flow = specFlow();
    flow.nodes.supervisor = {
      type: 'approval',
      approvers: [{ type: 'site' }],
      mode: 'any',
    } as never;
    await renderEditor(flow, { approverTypes: types });
    selectNode('supervisor');
    expect(panel().getByLabelText('Site')).toHaveAttribute('type', 'text');
    selectNode('review');
    await act(async () => {
      resolve([{ value: 'jkt', label: 'Jakarta' }]);
      await Promise.resolve();
    });
    expect(panel().getByRole('textbox', { name: 'Node ID' })).toHaveValue('review');
  });
});
