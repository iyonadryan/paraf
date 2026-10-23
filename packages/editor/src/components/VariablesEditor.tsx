import { useState } from 'react';
import type { DocumentVariable, DocumentVariableType } from '@paraf/core';
import { useEditor } from '../context';
import { updateFlow } from '../model/edit';
import { Segmented, TextField } from './fields';
import { CloseIcon } from './icons';

const TYPES: DocumentVariableType[] = ['number', 'text', 'select', 'date', 'boolean', 'user'];
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

function VariableForm(props: {
  initial: DocumentVariable;
  otherKeys: readonly string[];
  onSave: (variable: DocumentVariable) => void;
  onCancel: () => void;
  title: string;
}) {
  const { messages } = useEditor();
  const [draft, setDraft] = useState<DocumentVariable>(props.initial);
  const [option, setOption] = useState('');
  const [error, setError] = useState<string | undefined>();
  const options = draft.options ?? [];

  const addOption = () => {
    const value = option.trim();
    if (value === '' || options.includes(value)) return;
    setDraft({ ...draft, options: [...options, value] });
    setOption('');
  };

  const save = () => {
    const key = draft.key.trim();
    if (!KEY_PATTERN.test(key)) {
      setError(messages.variableKeyInvalid);
      return;
    }
    if (props.otherKeys.includes(key)) {
      setError(messages.variableKeyTaken);
      return;
    }
    const variable: DocumentVariable = { key, type: draft.type };
    if (draft.label?.trim()) variable.label = draft.label.trim();
    if (draft.type === 'select') variable.options = options;
    if (draft.required !== undefined) variable.required = draft.required;
    props.onSave(variable);
    return undefined;
  };

  return (
    <div
      className="paraf-card paraf-card--accent paraf-stack"
      role="group"
      aria-label={props.title}
    >
      <span className="paraf-strong">{props.title}</span>
      <div className="paraf-grid-2">
        <TextField
          label={messages.variableKey}
          mono
          value={draft.key}
          error={error}
          onChange={(key) => {
            setDraft({ ...draft, key });
            setError(undefined);
          }}
        />
        <TextField
          label={messages.label}
          value={draft.label ?? ''}
          onChange={(label) => {
            setDraft({ ...draft, label });
          }}
        />
      </div>
      <Segmented
        label={messages.variableType}
        value={draft.type}
        options={TYPES.map((type) => ({ value: type, label: messages.variableTypes[type] }))}
        onChange={(type) => {
          setDraft({ ...draft, type });
        }}
      />
      {draft.type === 'select' && (
        <div className="paraf-field">
          <span className="paraf-field__label">{messages.variableOptions}</span>
          <div className="paraf-chips">
            {options.map((value) => (
              <span key={value} className="paraf-chip paraf-chip--neutral">
                {value}
                <button
                  type="button"
                  className="paraf-chip__remove"
                  aria-label={`${messages.remove} ${value}`}
                  onClick={() => {
                    setDraft({
                      ...draft,
                      options: options.filter((item) => item !== value),
                    });
                  }}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            ))}
            <input
              type="text"
              aria-label={messages.addOption}
              className="paraf-chip-input"
              placeholder={messages.addOption}
              value={option}
              onChange={(event) => {
                setOption(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addOption();
                }
              }}
              onBlur={addOption}
            />
          </div>
        </div>
      )}
      <label className="paraf-check">
        <input
          type="checkbox"
          checked={draft.required ?? false}
          onChange={(event) => {
            setDraft({ ...draft, required: event.target.checked });
          }}
        />
        {messages.variableRequired}
      </label>
      <div className="paraf-actions-row">
        <button type="button" className="paraf-button" onClick={props.onCancel}>
          {messages.cancel}
        </button>
        <button type="button" className="paraf-button paraf-button--primary" onClick={save}>
          {messages.save}
        </button>
      </div>
    </div>
  );
}

/** The flow's document variables: a table plus an add/edit form. */
export function VariablesEditor() {
  const { flow, commit, messages, readOnly } = useEditor();
  const variables = flow.variables ?? [];
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const setVariables = (next: DocumentVariable[]) => {
    commit(updateFlow(flow, { variables: next.length > 0 ? next : undefined }));
  };

  return (
    <div className="paraf-stack">
      <div className="paraf-section__header">
        <h4>{messages.variablesTitle}</h4>
        <span className="paraf-hint">{messages.variableCount(variables.length)}</span>
      </div>
      {variables.length === 0 && editing === null && (
        <div className="paraf-empty-card">
          <span>{messages.variablesHint}</span>
          <button
            type="button"
            className="paraf-button paraf-button--outline"
            disabled={readOnly}
            onClick={() => {
              setEditing('new');
            }}
          >
            {messages.addVariable}
          </button>
        </div>
      )}
      {variables.length > 0 && (
        <table className="paraf-table">
          <thead>
            <tr>
              <th>{messages.variableKey}</th>
              <th>{messages.variableType}</th>
              <th>{messages.variableRequiredShort}</th>
              <th aria-label={messages.remove} />
            </tr>
          </thead>
          <tbody>
            {variables.map((variable, index) => (
              <tr
                key={variable.key}
                className={editing === index ? 'paraf-row--selected' : undefined}
              >
                <td>
                  <button
                    type="button"
                    className="paraf-link-cell"
                    disabled={readOnly}
                    onClick={() => {
                      setEditing(index);
                    }}
                  >
                    <span className="paraf-mono">{variable.key}</span>
                    {variable.label && <span className="paraf-hint">{variable.label}</span>}
                  </button>
                </td>
                <td>
                  <span className={`paraf-chip paraf-chip--${variable.type}`}>
                    {messages.variableTypes[variable.type]}
                  </span>
                </td>
                <td>{variable.required ? messages.yes : messages.no}</td>
                <td>
                  <button
                    type="button"
                    className="paraf-button paraf-button--icon"
                    aria-label={`${messages.remove} ${variable.key}`}
                    disabled={readOnly}
                    onClick={() => {
                      setVariables(variables.filter((_item, i) => i !== index));
                      setEditing(null);
                    }}
                  >
                    <CloseIcon size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing !== null ? (
        <VariableForm
          key={String(editing)}
          title={
            editing === 'new' ? messages.addVariable.replace(/^\+\s*/, '') : messages.editVariable
          }
          initial={
            editing === 'new'
              ? { key: '', type: 'number' }
              : (variables[editing] as DocumentVariable)
          }
          otherKeys={variables.filter((_item, i) => i !== editing).map((item) => item.key)}
          onCancel={() => {
            setEditing(null);
          }}
          onSave={(variable) => {
            setVariables(
              editing === 'new'
                ? [...variables, variable]
                : variables.map((item, i) => (i === editing ? variable : item)),
            );
            setEditing(null);
          }}
        />
      ) : (
        variables.length > 0 && (
          <button
            type="button"
            className="paraf-button paraf-button--dashed"
            disabled={readOnly}
            onClick={() => {
              setEditing('new');
            }}
          >
            {messages.addVariable}
          </button>
        )
      )}
    </div>
  );
}
