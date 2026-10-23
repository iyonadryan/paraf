// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryStore } from '@paraf/core';
import type { ParafEngine } from '@paraf/core';
import { createStudioHandler } from '../src/handler';
import type { StudioUser } from '../src/handler';
import { api, ApiError, toDraft } from '../ui/src/api';
import { App, isProductionLabel } from '../ui/src/App';
import { hrefOf, navigate, parseRoute } from '../ui/src/router';
import { createTestEngine, sampleFlow, UI_FIXTURE } from './fixtures';

interface Setup {
  engine?: ParafEngine;
  label?: string;
  user?: StudioUser | null;
  hash?: string;
}

/** Renders the studio against a real handler: `fetch` is routed into it. */
async function renderStudio(setup: Setup = {}) {
  const engine = setup.engine ?? createTestEngine();
  if (!setup.engine) await engine.publishFlow(sampleFlow(), { createdBy: 'seed', notes: 'First' });
  const handler = createStudioHandler({
    engine,
    ...(setup.label ? { label: setup.label } : {}),
    uiDir: UI_FIXTURE,
  });
  const user = setup.user === undefined ? { id: 'dev-1' } : setup.user;
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost/paraf/');
    return handler(new Request(url, init), { path: url.pathname.slice('/paraf'.length), user });
  });
  vi.stubGlobal('fetch', fetchMock);
  window.location.hash = setup.hash ?? '';
  const userEvents = userEvent.setup({ pointerEventsCheck: 0 });
  render(<App />);
  return { engine, user: userEvents, fetchMock };
}

/** Waits until the editor's canvas nodes are measured and visible. */
async function editorReady() {
  await screen.findByTestId('node-manager');
  await waitFor(() => {
    expect(document.querySelector('.react-flow__node[style*="visibility: hidden"]')).toBeNull();
  });
}

/** `window.confirm`, answering yes unless a test says otherwise. */
const confirmMock = vi.fn(() => true);

beforeEach(() => {
  confirmMock.mockClear();
  confirmMock.mockReturnValue(true);
  vi.stubGlobal('confirm', confirmMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('session', () => {
  it('shows the label, in red for production, and the user', async () => {
    await renderStudio({ label: 'PRODUCTION', user: { id: 'dev-1', name: 'Dev One' } });
    const label = await screen.findByText('PRODUCTION');
    expect(label).toHaveClass('studio-label--production');
    expect(screen.getByText('Dev One')).toBeInTheDocument();
    expect(isProductionLabel('staging')).toBe(false);
  });

  it('shows a neutral label, the user ID, or nothing', async () => {
    await renderStudio({ label: 'staging' });
    expect(await screen.findByText('staging')).not.toHaveClass('studio-label--production');
    expect(screen.getByText('dev-1')).toBeInTheDocument();
  });

  it('works without a label or user', async () => {
    await renderStudio({ user: null });
    await screen.findByRole('heading', { name: 'Flows' });
    expect(document.querySelector('.studio-label')).toBeNull();
    expect(document.querySelector('.studio-user')).toBeNull();
  });

  it('explains a locked studio, a refused user, and a server that cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))),
    );
    const { unmount } = render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Paraf Studio is locked' }),
    ).toBeInTheDocument();
    unmount();

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 403 }))),
    );
    const second = render(<App />);
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
    second.unmount();

    const failing = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', failing);
    render(<App />);
    expect(await screen.findByText('TypeError: Failed to fetch')).toBeInTheDocument();
    const { fetchMock } = await (async () => {
      const engine = createTestEngine();
      await engine.publishFlow(sampleFlow());
      const handler = createStudioHandler({ engine, uiDir: UI_FIXTURE });
      const mock = vi.fn((input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://localhost/paraf/');
        return handler(new Request(url, init), { path: url.pathname.slice(6), user: null });
      });
      return { fetchMock: mock };
    })();
    vi.stubGlobal('fetch', fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Flows' })).toBeInTheDocument();
  });
});

describe('flow list', () => {
  it('lists flows with their versions', async () => {
    const store = new MemoryStore();
    await store.saveFlowVersion({
      ...sampleFlow({ id: 'draft-only', name: 'Draft only' }),
      version: 1,
    });
    const engine = createTestEngine(store);
    await engine.publishFlow(sampleFlow());
    await renderStudio({ engine });
    const rows = await screen.findAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'FlowIDActiveLatest',
      'Draft onlydraft-onlynonev1',
      'Purchase requestpurchase-requestv1v1',
    ]);
    expect(screen.getByRole('link', { name: 'Purchase request' })).toHaveAttribute(
      'href',
      '#/flows/purchase-request',
    );
  });

  it('shows an empty state and errors', async () => {
    await renderStudio({ engine: createTestEngine() });
    expect(await screen.findByText('No flows yet')).toBeInTheDocument();
  });

  it('reports a list that cannot be loaded', async () => {
    const engine = createTestEngine();
    vi.spyOn(engine, 'listFlows').mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await renderStudio({ engine });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Internal error; see the server log.',
    );
  });
});

describe('flow page', () => {
  it('opens a flow, publishes it with notes, and shows the result', async () => {
    const { user, engine } = await renderStudio({
      hash: '#/flows/purchase-request',
      label: 'staging',
    });
    await editorReady();
    expect(screen.getByText('active: v1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish v2' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 2' });
    expect(within(dialog).getByText(/^Publishing to staging\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/0 documents in progress/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), 'Same flow again');
    await user.click(within(dialog).getByRole('button', { name: 'Publish v2' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Published purchase-request v2.');
    expect(await screen.findByText('active: v2')).toBeInTheDocument();
    expect((await engine.listFlowVersions('purchase-request'))[0]).toMatchObject({
      createdBy: 'dev-1',
      notes: 'Same flow again',
    });
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('lists versions, opens one, and makes one active', async () => {
    const engine = createTestEngine();
    await engine.publishFlow(sampleFlow(), { createdBy: 'seed', notes: 'First' });
    await engine.publishFlow(sampleFlow({ name: 'Second' }));
    const { user } = await renderStudio({ engine, hash: '#/flows/purchase-request' });
    await editorReady();
    await user.click(screen.getByRole('button', { name: 'Versions (2)' }));
    const drawer = screen.getByRole('complementary', { name: 'Versions' });
    const items = within(drawer).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/v2active.*Second/);
    expect(items[1]).toHaveTextContent('seed');
    expect(items[1]).toHaveTextContent('First');
    expect(
      within(items[0] as HTMLElement).queryByRole('button', { name: 'Make active' }),
    ).toBeNull();

    await user.click(
      within(items[1] as HTMLElement).getByRole('button', { name: 'Open in editor' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/^Opened v1\./);
    expect(screen.queryByRole('complementary', { name: 'Versions' })).not.toBeInTheDocument();
    expect(screen.getByText('Purchase request')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Versions (2)' }));
    await user.click(screen.getByRole('button', { name: 'Make active' }));
    const confirm = screen.getByRole('dialog', { name: 'Make v1 active' });
    expect(confirm).toHaveTextContent('New submissions will use v1 instead of v2.');
    await user.click(within(confirm).getByRole('button', { name: 'Make v1 active' }));
    expect(await screen.findByText('v1 is now active.')).toBeInTheDocument();
    expect((await engine.getActiveFlow('purchase-request'))?.version).toBe(1);
    // The opened (unpublished) draft is kept.
    expect(screen.getByText('active: v1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish v3' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Versions' })).not.toBeInTheDocument();
  });

  it('confirms before discarding edits', async () => {
    const { user } = await renderStudio({ hash: '#/flows/purchase-request' });
    await editorReady();
    await user.type(screen.getByLabelText('Flow name'), '!');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    confirmMock.mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Versions (1)' }));
    await user.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(screen.getByLabelText('Flow name')).toHaveValue('Purchase request!');
    fireEvent.click(screen.getByRole('link', { name: '← Flows' }));
    expect(window.location.hash).toBe('#/flows/purchase-request');

    confirmMock.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Open in editor' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Flow name')).toHaveValue('Purchase request');
    });
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it('keeps edits when making a version active, and reports failures', async () => {
    const engine = createTestEngine();
    await engine.publishFlow(sampleFlow());
    await engine.publishFlow(sampleFlow({ name: 'Second' }));
    const activate = vi
      .spyOn(engine, 'activateFlowVersion')
      .mockRejectedValueOnce(new Error('locked'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { user } = await renderStudio({
      engine,
      hash: '#/flows/purchase-request',
      label: 'PRODUCTION',
    });
    await editorReady();
    await user.type(screen.getByLabelText('Flow name'), '!');
    await user.click(screen.getByRole('button', { name: 'Versions (2)' }));
    await user.click(screen.getByRole('button', { name: 'Make active' }));
    const confirm = screen.getByRole('dialog', { name: 'Make v1 active' });
    expect(confirm).toHaveTextContent('New submissions in PRODUCTION will use v1 instead of v2.');
    await user.click(within(confirm).getByRole('button', { name: 'Make v1 active' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('Internal error');
    await user.click(within(confirm).getByRole('button', { name: 'Make v1 active' }));
    expect(await screen.findByText('v1 is now active.')).toBeInTheDocument();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Flow name')).toHaveValue('Second!');

    await user.click(screen.getByRole('button', { name: 'Make active' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make active' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports a version that cannot be opened', async () => {
    const engine = createTestEngine();
    await engine.publishFlow(sampleFlow());
    const { user } = await renderStudio({ engine, hash: '#/flows/purchase-request' });
    await editorReady();
    vi.spyOn(engine, 'getFlow').mockResolvedValueOnce(null);
    await user.click(screen.getByRole('button', { name: 'Versions (1)' }));
    await user.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(await screen.findByRole('status')).toHaveTextContent('has no version 1');
  });

  it('shows the latest version of a flow without an active one', async () => {
    const store = new MemoryStore();
    await store.saveFlowVersion({ ...sampleFlow({ name: 'Never active' }), version: 1 });
    const { user } = await renderStudio({
      engine: createTestEngine(store),
      hash: '#/flows/purchase-request',
    });
    await editorReady();
    expect(screen.getByLabelText('Flow name')).toHaveValue('Never active');
    expect(screen.getByRole('button', { name: 'Publish v2' })).toBeInTheDocument();
    expect(screen.queryByText(/^active:/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Versions (1)' }));
    await user.click(screen.getByRole('button', { name: 'Make active' }));
    const confirm = screen.getByRole('dialog', { name: 'Make v1 active' });
    expect(confirm).toHaveTextContent('New submissions will use v1. Documents in progress');
    await user.keyboard('{Enter}');
    expect(confirm).toBeInTheDocument();
  });

  it('follows a flow ID change to the new flow', async () => {
    const { user } = await renderStudio({ hash: '#/flows/purchase-request' });
    await editorReady();
    const id = screen.getByLabelText('Flow ID');
    await user.clear(id);
    await user.type(id, 'purchase-v2');
    await user.click(screen.getByRole('button', { name: 'Publish v2' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish v2' }),
    );
    await waitFor(() => {
      expect(window.location.hash).toBe('#/flows/purchase-v2');
    });
    expect(await screen.findByText('active: v1')).toBeInTheDocument();
  });

  it('explains a flow that does not exist', async () => {
    await renderStudio({ hash: '#/flows/missing' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Flow "missing" does not exist');
    expect(screen.getByRole('link', { name: 'Back to all flows' })).toHaveAttribute('href', '#/');
  });

  it('creates a new flow', async () => {
    const { user, engine } = await renderStudio({ hash: '#/new' });
    expect(await screen.findByText('This flow is empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Versions/ })).not.toBeInTheDocument();
    const file = new File(
      [JSON.stringify(sampleFlow({ id: 'leave-request', name: 'Leave' }))],
      'f.json',
    );
    fireEvent.change(screen.getByTestId('paraf-import'), { target: { files: [file] } });
    await screen.findByTestId('node-manager');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish v1' }),
    );
    await waitFor(() => {
      expect(window.location.hash).toBe('#/flows/leave-request');
    });
    expect((await engine.getActiveFlow('leave-request'))?.name).toBe('Leave');
    // Leaving after publishing does not ask.
    await screen.findByText('active: v1');
    fireEvent.click(screen.getByRole('link', { name: '← Flows' }));
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe('routing and API client', () => {
  it('maps hashes to pages and back', () => {
    expect(parseRoute('')).toEqual({ page: 'flows' });
    expect(parseRoute('#/flows/')).toEqual({ page: 'flows' });
    expect(parseRoute('#/new')).toEqual({ page: 'new' });
    expect(parseRoute('#/flows/a%2Fb')).toEqual({ page: 'flow', id: 'a/b' });
    expect(hrefOf({ page: 'flow', id: 'a/b' })).toBe('#/flows/a%2Fb');
    expect(hrefOf({ page: 'new' })).toBe('#/new');
    navigate({ page: 'new' });
    expect(window.location.hash).toBe('#/new');
  });

  it('reports responses that are not JSON by their status text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('<html>', { status: 502, statusText: 'Bad Gateway' })),
      ),
    );
    await expect(api.flows()).rejects.toEqual(new ApiError(502, 'Bad Gateway'));
    expect(toDraft({ ...sampleFlow(), version: 3 })).toEqual(sampleFlow());
  });

  it('renders into #root from the entry module', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await renderStudioFetchOnly();
    await act(async () => {
      await import('../ui/src/main');
    });
    expect(await within(root).findByRole('heading', { name: 'Flows' })).toBeInTheDocument();
    root.remove();
  });
});

/** Routes `fetch` into a handler without rendering (for the entry-module test). */
async function renderStudioFetchOnly() {
  const engine = createTestEngine();
  await engine.publishFlow(sampleFlow());
  const handler = createStudioHandler({ engine, uiDir: UI_FIXTURE });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost/paraf/');
      return handler(new Request(url, init), { path: url.pathname.slice(6), user: null });
    }),
  );
}
