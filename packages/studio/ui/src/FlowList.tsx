import { useEffect, useState } from 'react';
import type { FlowSummary } from '@paraf/core';
import { api } from './api';
import { hrefOf } from './router';

/** Every flow in the database, with its active and latest versions. */
export function FlowList() {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // API calls reject with Errors.
    api.flows().then(setFlows, (caught: unknown) => {
      setError((caught as Error).message);
    });
  }, []);

  return (
    <main className="studio-page">
      <div className="studio-page__head">
        <h1>Flows</h1>
        <a className="paraf-button paraf-button--primary" href={hrefOf({ page: 'new' })}>
          New flow
        </a>
      </div>
      {error && (
        <p className="paraf-error" role="alert">
          {error}
        </p>
      )}
      {!flows && !error && <p className="studio-loading">Loading…</p>}
      {flows?.length === 0 && (
        <div className="studio-empty">
          <b>No flows yet</b>
          <span>Create one, or publish one from your code with engine.publishFlow().</span>
        </div>
      )}
      {flows && flows.length > 0 && (
        <table className="studio-table">
          <thead>
            <tr>
              <th>Flow</th>
              <th>ID</th>
              <th>Active</th>
              <th>Latest</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((flow) => (
              <tr key={flow.id}>
                <td>
                  <a href={hrefOf({ page: 'flow', id: flow.id })}>{flow.name}</a>
                </td>
                <td className="paraf-mono">{flow.id}</td>
                <td>
                  {flow.activeVersion === null ? (
                    <span className="paraf-hint">none</span>
                  ) : (
                    `v${flow.activeVersion}`
                  )}
                </td>
                <td>v{flow.latestVersion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
