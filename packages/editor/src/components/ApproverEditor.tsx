import { useEffect, useId, useState } from 'react';
import type {
  ApproverEntry,
  ApproverTypeInfo,
  ConfigField,
  ConfigOption,
  JsonValue,
} from '@paraf/core';
import { patchNode, useEditor } from '../context';
import { toText } from '../model/display';
import { CloseIcon } from './icons';
import { Field, MenuButton, SelectField, useDraftText } from './fields';

/** Built-in approver types, available even when the app passes no `approverTypes`. */
const BUILTIN_TYPES: ApproverTypeInfo[] = [
  {
    type: 'user',
    label: 'Specific users',
    description: 'Pick people directly',
    configSchema: { value: { type: 'multiselect', label: 'User IDs', required: true } },
  },
  {
    type: 'field',
    label: 'From a document variable',
    description: 'For example, the person in charge (pic_user_id)',
    configSchema: { value: { type: 'text', label: 'Variable', required: true } },
  },
];

/** Registered approver types followed by the built-ins the app did not override. */
export function useApproverTypes(): ApproverTypeInfo[] {
  const { approverTypes } = useEditor();
  return [
    ...approverTypes,
    ...BUILTIN_TYPES.filter((builtin) => !approverTypes.some((type) => type.type === builtin.type)),
  ];
}

/** Resolves static or lazily loaded options. */
function useOptions(options: ConfigField['options']): ConfigOption[] | undefined {
  const [loaded, setLoaded] = useState<{ source: unknown; options: ConfigOption[] } | null>(null);
  useEffect(() => {
    if (typeof options !== 'function') return;
    let active = true;
    void Promise.resolve(options()).then((result) => {
      if (active) setLoaded({ source: options, options: result });
    });
    return () => {
      active = false;
    };
  }, [options]);
  if (typeof options !== 'function') return options;
  return loaded?.source === options ? loaded.options : undefined;
}

/** A multiselect stores one choice as a string and several as an array (or nothing). */
function fromSelection(values: string[]): JsonValue | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

/** The items of a comma-separated list. */
function splitList(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function toSelection(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value === undefined || value === null || value === '' ? [] : [toText(value)];
}

function MultiSelectChoices(props: {
  field: ConfigField;
  options: ConfigOption[];
  value: unknown;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const { messages, readOnly } = useEditor();
  const [query, setQuery] = useState('');
  const selected = toSelection(props.value);
  const shown = props.options.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset className="paraf-choices">
      <legend>{props.field.label}</legend>
      {props.options.length > 6 && (
        <input
          type="search"
          aria-label={`${messages.searchOptions} ${props.field.label}`}
          placeholder={messages.searchOptions}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      )}
      {shown.map((option) => (
        <label
          key={option.value}
          className={`paraf-choice${selected.includes(option.value) ? ' paraf-choice--on' : ''}`}
        >
          <input
            type="checkbox"
            checked={selected.includes(option.value)}
            disabled={readOnly}
            onChange={(event) => {
              const next = event.target.checked
                ? [...selected, option.value]
                : selected.filter((value) => value !== option.value);
              props.onChange(fromSelection(next));
            }}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function ConfigInput(props: {
  approverType: string;
  name: string;
  field: ConfigField;
  value: unknown;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const { flow, messages, readOnly } = useEditor();
  const listId = useId();
  const { field } = props;
  const options = useOptions(field.options);
  const isList = field.type === 'multiselect';
  const [text, setDraft] = useDraftText(
    isList
      ? toSelection(props.value).join(', ')
      : props.value === undefined
        ? ''
        : toText(props.value),
    (draft) => (isList ? splitList(draft).join(', ') : draft),
  );

  if (field.type === 'boolean') {
    return (
      <label className="paraf-toggle">
        <span className="paraf-toggle__text">{field.label}</span>
        <input
          type="checkbox"
          checked={props.value === true}
          disabled={readOnly}
          onChange={(event) => {
            props.onChange(event.target.checked ? true : undefined);
          }}
        />
      </label>
    );
  }
  if (field.type === 'multiselect' && options) {
    return (
      <MultiSelectChoices
        field={field}
        options={options}
        value={props.value}
        onChange={props.onChange}
      />
    );
  }
  if (field.type === 'select' && options) {
    return (
      <SelectField
        label={field.label}
        value={typeof props.value === 'string' ? props.value : ''}
        options={[{ value: '', label: messages.none }, ...options]}
        onChange={(value) => {
          props.onChange(value === '' ? undefined : value);
        }}
      />
    );
  }

  // The built-in "field" type points at a document variable: suggest the user variables.
  const suggestions =
    props.approverType === 'field' && props.name === 'value'
      ? (flow.variables ?? []).filter((variable) => variable.type === 'user')
      : [];
  const hint = isList
    ? messages.listHint
    : props.approverType === 'field' && suggestions.length === 0
      ? messages.noVariableOptions
      : undefined;
  return (
    <Field label={field.label} hint={hint}>
      {(id) => (
        <>
          <input
            id={id}
            type={field.type === 'number' ? 'number' : 'text'}
            className={props.approverType === 'field' ? 'paraf-mono' : undefined}
            list={suggestions.length > 0 ? listId : undefined}
            value={text}
            disabled={readOnly}
            onChange={(event) => {
              const raw = event.target.value;
              setDraft(raw);
              if (isList) {
                props.onChange(fromSelection(splitList(raw)));
              } else if (field.type === 'number') {
                props.onChange(raw === '' ? undefined : Number(raw));
              } else {
                props.onChange(raw === '' ? undefined : raw);
              }
            }}
          />
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map((variable) => (
                <option key={variable.key} value={variable.key}>
                  {variable.label ?? variable.key}
                </option>
              ))}
            </datalist>
          )}
        </>
      )}
    </Field>
  );
}

/** One approver source: its type and the type's configuration fields. */
export function SourceCard(props: {
  entry: ApproverEntry;
  onChange: (entry: ApproverEntry) => void;
  onRemove?: () => void;
}) {
  const { messages, readOnly } = useEditor();
  const types = useApproverTypes();
  const current = types.find((type) => type.type === props.entry.type);
  return (
    <div className="paraf-source">
      <div className="paraf-source__header">
        <span className="paraf-source__title">
          <span className="paraf-chip paraf-chip--accent">{props.entry.type}</span>
          {current?.label ?? props.entry.type}
        </span>
        {props.onRemove && (
          <button
            type="button"
            className="paraf-button paraf-button--icon"
            aria-label={`${messages.remove} ${current?.label ?? props.entry.type}`}
            disabled={readOnly}
            onClick={props.onRemove}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>
      <div className="paraf-source__body">
        {current ? (
          Object.entries(current.configSchema ?? {}).map(([name, field]) => (
            <ConfigInput
              key={name}
              approverType={props.entry.type}
              name={name}
              field={field}
              value={props.entry[name]}
              onChange={(value) => {
                props.onChange(patchNode(props.entry, { [name]: value }));
              }}
            />
          ))
        ) : (
          <>
            <p className="paraf-hint">{messages.unknownApproverType}</p>
            <pre className="paraf-code">{JSON.stringify(props.entry, null, 2)}</pre>
          </>
        )}
      </div>
    </div>
  );
}

/** Menu of approver types; `onSelect` gets the chosen type. */
export function AddSourceButton(props: { onSelect: (type: string) => void; label?: string }) {
  const { messages } = useEditor();
  const types = useApproverTypes();
  return (
    <MenuButton
      label={props.label ?? messages.addSource}
      title={messages.chooseSource}
      items={types.map((type) => ({
        key: type.type,
        title: type.label,
        ...(type.description ? { description: type.description } : {}),
      }))}
      onSelect={props.onSelect}
    />
  );
}

/** A list of approver sources with an "add source" menu. */
export function SourceList(props: {
  label?: string;
  entries: readonly ApproverEntry[] | undefined;
  onChange: (entries: ApproverEntry[]) => void;
  emptyHint?: string;
}) {
  const entries = props.entries ?? [];
  return (
    <div className="paraf-sources" role="group" aria-label={props.label}>
      {props.label && <span className="paraf-field__label">{props.label}</span>}
      {entries.length === 0 && props.emptyHint && (
        <p className="paraf-empty-hint">{props.emptyHint}</p>
      )}
      {entries.map((entry, index) => (
        <SourceCard
          key={index}
          entry={entry}
          onChange={(next) => {
            props.onChange(entries.map((item, i) => (i === index ? next : item)));
          }}
          onRemove={() => {
            props.onChange(entries.filter((_item, i) => i !== index));
          }}
        />
      ))}
      <AddSourceButton
        onSelect={(type) => {
          props.onChange([...entries, { type }]);
        }}
      />
    </div>
  );
}
