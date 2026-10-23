import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useEditor } from '../context';

/** A labelled form row: the label text above its control. */
export function Field(props: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={`paraf-field${props.error ? ' paraf-field--error' : ''}`}>
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
      {props.hint && <small className="paraf-hint">{props.hint}</small>}
      {props.error && (
        <small className="paraf-error" role="alert">
          {props.error}
        </small>
      )}
    </div>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  placeholder?: string;
  mono?: boolean;
}) {
  const { readOnly } = useEditor();
  return (
    <Field label={props.label} hint={props.hint} error={props.error}>
      {(id) => (
        <input
          id={id}
          type="text"
          className={props.mono ? 'paraf-mono' : undefined}
          value={props.value}
          placeholder={props.placeholder}
          disabled={readOnly}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

export function NumberField(props: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  compact?: boolean;
}) {
  const { readOnly } = useEditor();
  return (
    <Field label={props.label}>
      {(id) => (
        <input
          id={id}
          type="number"
          className={props.compact ? 'paraf-input--compact' : undefined}
          min={props.min}
          value={props.value ?? ''}
          disabled={readOnly}
          onChange={(event) => {
            const text = event.target.value;
            props.onChange(text === '' ? undefined : Number(text));
          }}
        />
      )}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField(props: {
  label: string;
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
}) {
  const { readOnly } = useEditor();
  return (
    <Field label={props.label}>
      {(id) => (
        <select
          id={id}
          value={props.value}
          disabled={readOnly}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        >
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/**
 * A select whose first choice leaves the setting out of the flow (the engine default), so an
 * explicit value equal to the default survives a round-trip.
 */
export function OptionalSelect<T extends string>(props: {
  label: string;
  value: T | undefined;
  defaultLabel: string;
  options: readonly { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
}) {
  const { messages } = useEditor();
  return (
    <SelectField
      label={props.label}
      value={props.value ?? ''}
      options={[{ value: '', label: messages.defaultOption(props.defaultLabel) }, ...props.options]}
      onChange={(value) => {
        props.onChange(value === '' ? undefined : (value as T));
      }}
    />
  );
}

/**
 * A checkbox with a title and an explanation. It shows the effective value; toggling it
 * writes an explicit value.
 */
export function Toggle(props: {
  label: [string, string] | string;
  value: boolean | undefined;
  defaultValue: boolean;
  onChange: (value: boolean) => void;
}) {
  const { readOnly } = useEditor();
  const [title, hint] = typeof props.label === 'string' ? [props.label, undefined] : props.label;
  return (
    <label className="paraf-toggle">
      <span className="paraf-toggle__text">
        <span>{title}</span>
        {hint && <span className="paraf-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={props.value ?? props.defaultValue}
        disabled={readOnly}
        onChange={(event) => {
          props.onChange(event.target.checked);
        }}
      />
    </label>
  );
}

/** A row of mutually exclusive buttons (aria-pressed). */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const { readOnly } = useEditor();
  return (
    <div className="paraf-field">
      <span className="paraf-field__label">{props.label}</span>
      <div
        role="group"
        aria-label={props.label}
        className="paraf-segmented"
        style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}
      >
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === props.value}
            disabled={readOnly}
            onClick={() => {
              if (option.value !== props.value) props.onChange(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Choose the node a reference points to. */
export function NodeTargetSelect(props: {
  label: string;
  value: string | undefined;
  onChange: (target: string | undefined) => void;
  exclude?: string;
}) {
  const { flow, messages } = useEditor();
  const options = Object.entries(flow.nodes)
    .filter(([id]) => id !== props.exclude)
    .map(([id, node]) => ({ value: id, label: node.label ? `${node.label} (${id})` : id }));
  if (props.value && !(props.value in flow.nodes)) {
    options.push({ value: props.value, label: `${props.value} (?)` });
  }
  return (
    <SelectField
      label={props.label}
      value={props.value ?? ''}
      options={[{ value: '', label: messages.none }, ...options]}
      onChange={(value) => {
        props.onChange(value === '' ? undefined : value);
      }}
    />
  );
}

/**
 * The text of an input that is parsed on every keystroke. Keeps what the user typed while it
 * still means the current value (a trailing comma, for example); otherwise shows the value.
 */
export function useDraftText(text: string, canonical: (draft: string) => string) {
  const [draft, setDraft] = useState<string | null>(null);
  return [draft !== null && canonical(draft) === text ? draft : text, setDraft] as const;
}

/** A titled block of the side panel. */
export function Section(props: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="paraf-section">
      {(props.title !== undefined || props.aside) && (
        <header className="paraf-section__header">
          {props.title !== undefined && <h4>{props.title}</h4>}
          {props.aside}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick: () => void;
  label?: string;
  variant?: 'default' | 'primary' | 'danger' | 'icon' | 'link' | 'dashed' | 'outline';
  disabled?: boolean;
  expanded?: boolean;
}) {
  const { readOnly } = useEditor();
  return (
    <button
      type="button"
      className={`paraf-button paraf-button--${props.variant ?? 'default'}`}
      aria-label={props.label}
      title={props.label}
      aria-expanded={props.expanded}
      disabled={readOnly || props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** Closes when clicking outside `ref` or pressing Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/** A button that opens a menu of choices with a title and a description. */
export function MenuButton(props: {
  label: string;
  title: string;
  items: readonly { key: string; title: string; description?: string; icon?: ReactNode }[];
  onSelect: (key: string) => void;
  variant?: 'dashed' | 'plus' | 'link';
  buttonLabel?: string;
}) {
  const { readOnly } = useEditor();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => {
    setOpen(false);
  });
  return (
    <div className="paraf-menu-anchor" ref={ref}>
      <button
        type="button"
        className={`paraf-button paraf-button--${props.variant ?? 'dashed'}`}
        aria-label={props.buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={readOnly}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {props.label}
      </button>
      {open && (
        <div role="menu" aria-label={props.title} className="paraf-menu">
          <span className="paraf-menu__title">{props.title}</span>
          {props.items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="paraf-menu__item"
              onClick={() => {
                setOpen(false);
                props.onSelect(item.key);
              }}
            >
              {item.icon}
              <span className="paraf-menu__text">
                <span className="paraf-menu__name">{item.title}</span>
                {item.description && <span className="paraf-hint">{item.description}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export { useDismiss };
