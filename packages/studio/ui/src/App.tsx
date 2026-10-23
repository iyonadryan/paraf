import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { Session } from './api';
import { FlowList } from './FlowList';
import { FlowPage } from './FlowPage';
import { hrefOf, useRoute } from './router';

/** Labels that mean production get the red badge. */
export function isProductionLabel(label: string): boolean {
  return /prod/i.test(label);
}

function Logo() {
  return (
    <a className="studio-logo" href={hrefOf({ page: 'flows' })}>
      <svg
        width="20"
        height="20"
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
      <span>studio</span>
    </a>
  );
}

function Bar({ session }: { session: Session }) {
  return (
    <header className="studio-bar">
      <Logo />
      {session.label && (
        <span
          className={`studio-label${isProductionLabel(session.label) ? ' studio-label--production' : ''}`}
          title="Flows are published to this database"
        >
          {session.label}
        </span>
      )}
      <span className="studio-bar__spacer" />
      {session.user && <span className="studio-user">{session.user.name ?? session.user.id}</span>}
    </header>
  );
}

function Message(props: { title: string; text: string; onRetry?: () => void }) {
  return (
    <div className="studio-message" role="alert">
      <h1>{props.title}</h1>
      <p>{props.text}</p>
      {props.onRetry && (
        <button type="button" className="paraf-button" onClick={props.onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Paraf Studio: the flow list and the flow pages. */
export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    api.session().then(setSession, (caught: unknown) => {
      setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught)));
    });
  }, []);
  useEffect(load, [load]);
  const retry = () => {
    setError(null);
    load();
  };

  let content;
  if (error?.status === 401) {
    content = (
      <Message
        title="Paraf Studio is locked"
        text="Open the link printed in the terminal where the studio started."
      />
    );
  } else if (error?.status === 403) {
    content = <Message title="No access" text="You are not allowed to use Paraf Studio." />;
  } else if (error) {
    content = (
      <Message title="Paraf Studio is not reachable" text={error.message} onRetry={retry} />
    );
  } else if (!session) {
    content = <p className="studio-loading">Loading…</p>;
  } else if (route.page === 'flows') {
    content = <FlowList />;
  } else {
    const id = route.page === 'flow' ? route.id : null;
    content = <FlowPage key={id ?? '(new)'} id={id} session={session} />;
  }

  return (
    <div className="paraf-editor studio">
      {session && <Bar session={session} />}
      <div className="studio-body">{content}</div>
    </div>
  );
}
