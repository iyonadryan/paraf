import { useCallback, useEffect, useState } from 'react';
import type { FlowDefinition, PublishedFlow } from '@paraf/core';
import { ParafEditor } from '@paraf/editor';
import { api, toDraft } from './api';
import type { FlowDetail, Session } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { hrefOf, navigate } from './router';
import { VersionsDrawer } from './Versions';

/** The draft a new flow starts from; its ID can be changed in the flow settings. */
export const NEW_FLOW: FlowDefinition = { id: 'new-flow', name: 'New flow', start: '', nodes: {} };

const DISCARD = 'Discard the changes you have not published?';

/** API calls reject with Errors. */
function message(error: unknown): string {
  return (error as Error).message;
}

interface LoadedFlow {
  detail: FlowDetail;
  /** The active version, or the latest when none is active. */
  flow: PublishedFlow;
}

async function fetchFlow(flowId: string): Promise<LoadedFlow> {
  const detail = await api.flow(flowId);
  // A flow always has a version.
  const shown = detail.activeVersion ?? (detail.versions[0] as { version: number }).version;
  return { detail, flow: await api.version(flowId, shown) };
}

/** One flow in the editor, with its version history; `id` is `null` for a new flow. */
export function FlowPage({ id, session }: { id: string | null; session: Session }) {
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [active, setActive] = useState<PublishedFlow | null>(null);
  // `base` is what the editor started from; `draft` differs from it once edited.
  const [base, setBase] = useState<FlowDefinition | null>(id === null ? NEW_FLOW : null);
  const [draft, setDraft] = useState<FlowDefinition | null>(id === null ? NEW_FLOW : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [activating, setActivating] = useState<number | null>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(base);

  /** Shows a loaded flow; unless `keepDraft`, the editor switches to the shown version. */
  const apply = useCallback((loaded: LoadedFlow, keepDraft: boolean) => {
    setDetail(loaded.detail);
    setActive(loaded.detail.activeVersion === null ? null : loaded.flow);
    if (!keepDraft) {
      setBase(toDraft(loaded.flow));
      setDraft(toDraft(loaded.flow));
    }
  }, []);

  useEffect(() => {
    if (id === null) return;
    fetchFlow(id).then(
      (loaded) => {
        apply(loaded, false);
      },
      (caught: unknown) => {
        setError(message(caught));
      },
    );
  }, [id, apply]);

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [dirty]);

  const publish = async (flow: FlowDefinition, notes: string) => {
    const published = await api.publish(flow, notes);
    setNotice(`Published ${published.id} v${published.version}.`);
    if (published.id === id) {
      apply(await fetchFlow(published.id), false);
    } else {
      // A new flow, or the flow ID was changed in the settings.
      setBase(flow);
      navigate({ page: 'flow', id: published.id });
    }
  };

  const openVersion = (version: number) => {
    if (id === null || (dirty && !window.confirm(DISCARD))) return;
    api.version(id, version).then(
      (flow) => {
        setDraft(toDraft(flow));
        setVersionsOpen(false);
        setNotice(`Opened v${version}. Publish it to make it a new version, or use "Make active".`);
      },
      (caught: unknown) => {
        setNotice(message(caught));
      },
    );
  };

  if (error) {
    return (
      <main className="studio-page">
        <p className="paraf-error" role="alert">
          {error}
        </p>
        <a href={hrefOf({ page: 'flows' })}>Back to all flows</a>
      </main>
    );
  }
  if (!draft) return <p className="studio-loading">Loading…</p>;

  const latest = detail?.versions[0]?.version ?? null;
  return (
    <div className="studio-flow">
      <ParafEditor
        value={draft}
        onChange={setDraft}
        approverTypes={session.approverTypes}
        chains={session.chains}
        operators={session.operators}
        headerStart={
          <span className="studio-flow__nav">
            <a
              href={hrefOf({ page: 'flows' })}
              onClick={(event) => {
                if (dirty && !window.confirm(DISCARD)) event.preventDefault();
              }}
            >
              ← Flows
            </a>
            {detail && (
              <button
                type="button"
                className="paraf-button"
                aria-expanded={versionsOpen}
                onClick={() => {
                  setVersionsOpen(!versionsOpen);
                }}
              >
                Versions ({detail.versions.length})
              </button>
            )}
          </span>
        }
        publish={{
          activeVersion: detail?.activeVersion ?? null,
          latestVersion: latest,
          activeFlow: active,
          ...(detail ? { runningInstances: detail.runningInstances } : {}),
          ...(session.label ? { target: session.label } : {}),
          onPublish: publish,
        }}
      />
      {notice && (
        <div className="studio-toast" role="status">
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setNotice(null);
            }}
          >
            ×
          </button>
        </div>
      )}
      {versionsOpen && detail && (
        <VersionsDrawer
          detail={detail}
          onOpen={openVersion}
          onActivate={setActivating}
          onClose={() => {
            setVersionsOpen(false);
          }}
        />
      )}
      {activating !== null && detail && (
        <ConfirmDialog
          title={`Make v${activating} active`}
          confirmLabel={`Make v${activating} active`}
          onClose={() => {
            setActivating(null);
          }}
          onConfirm={async () => {
            await api.activate(detail.id, activating);
            apply(await fetchFlow(detail.id), dirty);
            setNotice(`v${activating} is now active.`);
          }}
        >
          <p>
            New submissions{session.label ? ` in ${session.label}` : ''} will use v{activating}
            {detail.activeVersion === null ? '' : ` instead of v${detail.activeVersion}`}. Documents
            in progress keep the version they started with.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
