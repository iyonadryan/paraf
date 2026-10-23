import { render, screen, waitFor, within } from '@testing-library/react';
import type { FlowDefinition } from '@paraf/core';
import { ParafProgress } from '../src';
import type { ParafProgressProps } from '../src';
import { createTestEngine, specFlow } from './fixtures';

const names: Record<string, string> = { u7: 'Dimas', s1: 'Rina', m1: 'Budi', d1: 'Sari' };

async function start(flow: FlowDefinition, amount: number) {
  const engine = createTestEngine();
  const published = await engine.publishFlow(flow);
  const instance = await engine.start(published.id, {
    subject: { type: 'pr', id: 'PR/2026/10/001' },
    requester: { id: 'u7' },
    document: { amount },
  });
  const props = async (extra: Partial<ParafProgressProps> = {}): Promise<ParafProgressProps> => {
    const state = await engine.getInstance(instance.id);
    if (!state) throw new Error('missing instance');
    return { flow: published, state, history: await engine.getHistory(instance.id), ...extra };
  };
  return { engine, id: instance.id, props };
}

async function show(props: ParafProgressProps) {
  const view = render(
    <div style={{ width: 1200, height: 800 }}>
      <ParafProgress {...props} />
    </div>,
  );
  await waitFor(() => {
    expect(document.querySelector('.react-flow__node[style*="visibility: hidden"]')).toBeNull();
  });
  return view;
}

const card = (id: string) => screen.getByTestId(`progress-${id}`);

describe('ParafProgress', () => {
  it('shows done, active and upcoming steps with the history', async () => {
    const flow = specFlow();
    flow.variables = [{ key: 'amount', label: 'Amount', type: 'number' }];
    const { engine, id, props } = await start(flow, 15_000_000);
    await engine.approve(id, 's1', 'OK from me');
    await show(
      await props({
        userName: (user) => names[user] ?? user,
        formatDate: (date) => `at ${date.getUTCFullYear()}`,
        headerStart: <b>Logo</b>,
        className: 'mine',
      }),
    );
    expect(screen.getByText('Logo')).toBeInTheDocument();
    expect(screen.getByText('Read-only · flow v1')).toBeInTheDocument();
    expect(card('supervisor')).toHaveClass('paraf-pnode--done');
    expect(card('supervisor')).toHaveTextContent('Rina');
    expect(within(card('supervisor')).getByRole('img', { name: 'Done' })).toBeInTheDocument();
    expect(card('checkAmount')).toHaveTextContent('Condition');
    expect(card('chain')).toHaveClass('paraf-pnode--active');
    expect(card('chain')).toHaveTextContent('Lv 1 · Rina');
    expect(card('chain')).toHaveTextContent('Lv 2 · Budi');
    expect(
      within(card('chain')).getByRole('img', { name: 'Awaiting decision' }),
    ).toBeInTheDocument();
    expect(card('review')).toHaveTextContent('Manager');
    expect(card('review')).toHaveTextContent('at least 2');
    expect(card('review')).toHaveTextContent('Not started');
    expect(card('end_rejected')).toHaveClass('paraf-pnode--end-rejected');
    expect(screen.getByText('Submitted')).toBeInTheDocument();

    const side = screen.getByRole('complementary', { name: 'PR/2026/10/001' });
    expect(within(side).getByText('In progress · Naik sampai Direktur')).toBeInTheDocument();
    expect(within(side).getByText('Requester').nextElementSibling).toHaveTextContent('Dimas');
    expect(within(side).getByText('15,000,000')).toBeInTheDocument();
    const timeline = within(side).getByRole('list');
    expect(timeline).toHaveTextContent('Dimas submitted');
    expect(timeline).toHaveTextContent('Rina approved · Atasan Langsung');
    expect(timeline).toHaveTextContent('OK from me');
    expect(timeline).toHaveTextContent('System evaluated a condition · checkAmount');
    expect(timeline).toHaveTextContent('System auto-approved · Naik sampai Direktur');
    await waitFor(() => {
      expect(document.querySelectorAll('.react-flow__edge.paraf-edge--taken')).toHaveLength(3);
    });
    expect(document.querySelector('.paraf-progress.mine')).not.toBeNull();
  });

  it('shows group progress, the due date and a rejection', async () => {
    const { engine, id, props } = await start(specFlow(), 5);
    await engine.approve(id, 's1');
    await engine.approve(id, 'm1');
    const view = await show(await props());
    expect(card('review')).toHaveTextContent('Manager1 / 1');
    expect(card('review')).toHaveTextContent('Finance0 / 2');
    expect(card('chain')).toHaveClass('paraf-pnode--pending');
    // The default date format, as in "Oct 21 · 09:12".
    expect(
      within(card('supervisor')).getByText(/^[A-Z][a-z]{2} \d{1,2} · \d{2}:\d{2}$/),
    ).toBeInTheDocument();
    view.unmount();

    await engine.reject(id, 'f1', 'Over budget');
    await engine.reject(id, 'f2', 'Over budget');
    await engine.reject(id, 'f3', 'Over budget');
    await show(await props({ messages: { statusRejected: 'Ditolak' } }));
    expect(card('review')).toHaveClass('paraf-pnode--rejected');
    expect(within(card('review')).getByRole('img', { name: 'Ditolak' })).toBeInTheDocument();
    expect(screen.getAllByText('Rejected').length).toBeGreaterThan(0);
    expect(screen.getByRole('list')).toHaveTextContent('f1 rejected · Manager & Finance (paralel)');
  });

  it('shows the due date of a step with a timeout, and steps without a label', async () => {
    const flow = specFlow();
    flow.variables = [{ key: 'missing', type: 'text' }];
    flow.nodes.supervisor = {
      type: 'approval',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      onReject: 'end_rejected',
      timeout: { after: 'P3D', action: 'escalate', to: [{ type: 'supervisor', level: 2 }] },
      next: 'checkAmount',
    } as never;
    const { props } = await start(flow, 1);
    await show(await props());
    const side = screen.getByRole('complementary');
    expect(within(side).getByText('Due')).toBeInTheDocument();
    expect(within(side).getByText('—')).toBeInTheDocument();
    expect(within(side).getByText(/^Pending · supervisor$/)).toBeInTheDocument();
    expect(card('chain')).not.toHaveTextContent('Lv');
    expect(card('end_approved')).toHaveTextContent('end_approved');
  });

  it('describes a single-group step that has not started', async () => {
    const flow = specFlow();
    flow.nodes.review = {
      type: 'approval',
      label: 'Review',
      approvers: [{ type: 'role', value: 'manager' }],
      mode: 'all',
      next: 'end_approved',
      onReject: 'end_rejected',
    } as never;
    flow.layout = { review: { x: 500, y: 500 } };
    const { props } = await start(flow, 1);
    await show(await props());
    expect(card('review')).toHaveTextContent('Role: manager · all');
    expect(card('review')).toHaveTextContent('Not started');
  });

  it('shows a dash for a chain level without a user, and unlabelled groups by ID', async () => {
    const flow = specFlow();
    for (const group of (flow.nodes.review as { groups: { label?: string }[] }).groups) {
      Reflect.deleteProperty(group, 'label');
    }
    const { engine, id, props } = await start(flow, 15_000_000);
    await engine.approve(id, 's1');
    const current = await props();
    const step = current.state.steps.find(
      (item) => item.nodeId === 'chain' && item.status === 'active',
    );
    Reflect.deleteProperty(step?.config ?? {}, 'chain');
    await show(current);
    expect(card('chain')).toHaveTextContent('Lv 2 · —');
    expect(card('review')).toHaveTextContent('mgrany 1');
    expect(card('review')).toHaveTextContent('finat least 2');
  });

  it('draws no Submitted pill when the start node is missing', async () => {
    const { props } = await start(specFlow(), 1);
    const current = await props();
    await show({ ...current, flow: { ...current.flow, start: 'ghost' } });
    expect(screen.queryByText('Submitted')).not.toBeInTheDocument();
    expect(card('supervisor')).toBeInTheDocument();
  });
});
