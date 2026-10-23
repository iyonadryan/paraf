import type { FlowDetail } from './api';

function formatDate(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The versions of a flow: open one in the editor, or make it the active one (rollback). */
export function VersionsDrawer(props: {
  detail: FlowDetail;
  onOpen: (version: number) => void;
  onActivate: (version: number) => void;
  onClose: () => void;
}) {
  const { detail } = props;
  return (
    <aside className="studio-drawer" aria-label="Versions">
      <div className="studio-drawer__head">
        <h2>Versions</h2>
        <button type="button" className="paraf-button" onClick={props.onClose}>
          Close
        </button>
      </div>
      <p className="paraf-hint">
        New submissions use the active version. Documents in progress keep the version they started
        with.
      </p>
      <ol className="studio-versions">
        {detail.versions.map((version) => {
          const active = version.version === detail.activeVersion;
          return (
            <li key={version.version} className={active ? 'studio-version--active' : undefined}>
              <div className="studio-version__head">
                <b>v{version.version}</b>
                {active && <span className="studio-badge-active">active</span>}
                <span className="studio-version__name">{version.name}</span>
              </div>
              <span className="paraf-hint">
                {formatDate(version.createdAt)}
                {version.createdBy && ` · ${version.createdBy}`}
              </span>
              {version.notes && <p className="studio-version__notes">{version.notes}</p>}
              <div className="studio-version__actions">
                <button
                  type="button"
                  className="paraf-button"
                  onClick={() => {
                    props.onOpen(version.version);
                  }}
                >
                  Open in editor
                </button>
                {!active && (
                  <button
                    type="button"
                    className="paraf-button"
                    onClick={() => {
                      props.onActivate(version.version);
                    }}
                  >
                    Make active
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
