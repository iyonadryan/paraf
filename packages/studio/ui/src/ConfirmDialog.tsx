import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** A modal question with a confirm button that runs an async action. */
export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { onClose } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="paraf-overlay">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        className="paraf-dialog studio-confirm"
      >
        <div className="paraf-dialog__head">
          <h2>{props.title}</h2>
        </div>
        <div className="paraf-dialog__body">
          {props.children}
          {error && (
            <span className="paraf-error" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="paraf-dialog__foot">
          <button type="button" className="paraf-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="paraf-button paraf-button--primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              props.onConfirm().then(onClose, (caught: unknown) => {
                // API calls reject with Errors.
                setError((caught as Error).message);
                setBusy(false);
              });
            }}
          >
            {props.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
