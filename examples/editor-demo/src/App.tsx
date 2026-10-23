import { useState } from 'react';
import type { AuditEntry, FlowDefinition, InstanceState, PublishedFlow } from '@paraf/core';
import { ParafEditor, ParafProgress } from '@paraf/editor';
import '@paraf/editor/style.css';
import { indonesianMessages } from './messages-id';
import { approverTypes, chains, directory, engine } from './registries';

const emptyFlow: FlowDefinition = {
  id: 'purchase-request',
  name: 'Purchase Request',
  start: '',
  nodes: {},
};

function Logo() {
  return (
    <span className="demo-logo">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 17c3-1 4-8 7-8s1 7 4 7 3-5 7-6" />
        <path d="M3 21h18" />
      </svg>
      <b>paraf</b>
      <span className="demo-crumb">Flows /</span>
    </span>
  );
}

/** A sample document: a value for every declared variable. */
function sampleDocument(flow: FlowDefinition): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const variable of flow.variables ?? []) {
    document[variable.key] =
      variable.type === 'number'
        ? 15_000_000
        : variable.type === 'select'
          ? variable.options?.[0]
          : variable.type === 'boolean'
            ? false
            : variable.type === 'date'
              ? '2026-11-01'
              : variable.type === 'user'
                ? 's1'
                : 'Laptop for the design team';
  }
  return document;
}

export function App() {
  const [flow, setFlow] = useState<FlowDefinition>(emptyFlow);
  const [active, setActive] = useState<PublishedFlow | null>(null);
  const [language, setLanguage] = useState<'en' | 'id'>('en');
  const [view, setView] = useState<'editor' | 'progress'>('editor');
  const [run, setRun] = useState<{ state: InstanceState; history: AuditEntry[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const messages = language === 'id' ? indonesianMessages : undefined;
  const userName = (id: string) => directory.names[id] ?? id;

  const refresh = async (instanceId: string) => {
    const state = await engine.getInstance(instanceId);
    if (state) setRun({ state, history: await engine.getHistory(instanceId) });
  };

  const simulate = async () => {
    if (!active) return;
    try {
      const instance = await engine.start(active.id, {
        subject: { type: 'purchase_request', id: `PR/2026/10/${String(Date.now()).slice(-3)}` },
        requester: { id: 'u7' },
        document: sampleDocument(active) as never,
      });
      setMessage(null);
      await refresh(instance.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const pending = run?.state.approvers.find(
    (slot) => slot.stepId === run.state.instance.currentStepId && slot.status === 'pending',
  );

  return (
    <div className="demo">
      <div className="demo__bar">
        <div role="tablist" aria-label="View" className="demo__tabs">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'editor'}
            onClick={() => {
              setView('editor');
            }}
          >
            Editor
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'progress'}
            onClick={() => {
              setView('progress');
            }}
          >
            Progress
          </button>
        </div>
        <label>
          Language{' '}
          <select
            aria-label="Language"
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value as 'en' | 'id');
            }}
          >
            <option value="en">English</option>
            <option value="id">Bahasa Indonesia</option>
          </select>
        </label>
        {view === 'editor' && (
          <button
            type="button"
            onClick={() => {
              setFlow(emptyFlow);
            }}
          >
            New flow
          </button>
        )}
        {view === 'progress' && (
          <>
            <button type="button" disabled={!active} onClick={() => void simulate()}>
              {active ? `Submit a document (v${active.version})` : 'Publish a flow first'}
            </button>
            {pending && run && (
              <button
                type="button"
                onClick={() =>
                  void engine
                    .approve(run.state.instance.id, pending.userId, 'Looks good')
                    .then(() => refresh(run.state.instance.id))
                }
              >
                Approve as {userName(pending.userId)}
              </button>
            )}
          </>
        )}
        {message && <span className="demo__error">{message}</span>}
      </div>
      <main className="demo__main">
        {view === 'editor' ? (
          <ParafEditor
            value={flow}
            onChange={setFlow}
            approverTypes={approverTypes}
            chains={chains}
            headerStart={<Logo />}
            publish={{
              activeVersion: active?.version ?? null,
              activeFlow: active,
              runningInstances: run ? 1 : 0,
              onPublish: async (draft) => {
                setActive(await engine.publishFlow(draft));
              },
            }}
            {...(messages ? { messages } : {})}
          />
        ) : run && active ? (
          <ParafProgress
            flow={active}
            state={run.state}
            history={run.history}
            userName={userName}
            headerStart={<Logo />}
            {...(messages ? { messages } : {})}
          />
        ) : (
          <p className="demo__placeholder">
            Publish a flow in the editor, then submit a document here.
          </p>
        )}
      </main>
    </div>
  );
}
