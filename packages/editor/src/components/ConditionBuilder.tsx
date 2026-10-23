import { useId, useState } from 'react';
import type { ConditionExpression, DocumentVariable } from '@paraf/core';
import { useEditor } from '../context';
import {
  buildCondition,
  coerceValue,
  COMPARISON_OPERATORS,
  parseCondition,
  valueText,
} from '../model/condition';
import type { Comparison, ConditionModel, ValueType } from '../model/condition';
import { useDismiss, useDraftText } from './fields';
import { ChevronDownIcon, CloseIcon } from './icons';

const VALUE_TYPES: ValueType[] = ['text', 'number', 'boolean', 'list'];

/** How a variable's values are typed in a comparison. */
function valueTypeOf(variable: DocumentVariable): ValueType {
  if (variable.type === 'number') return 'number';
  if (variable.type === 'boolean') return 'boolean';
  return 'text';
}

function initialValue(variable: DocumentVariable): Comparison['value'] {
  if (variable.type === 'number') return 0;
  if (variable.type === 'boolean') return true;
  if (variable.type === 'select') return variable.options?.[0] ?? '';
  return '';
}

/** Button that opens a list of document variables, plus a free path input. */
function FieldPicker(props: {
  value: string;
  onChange: (field: string, variable?: DocumentVariable) => void;
}) {
  const { flow, messages, readOnly } = useEditor();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => {
    setOpen(false);
  });
  const variables = flow.variables ?? [];
  const current = variables.find((variable) => variable.key === props.value);
  const [custom, setCustom] = useState(current ? '' : props.value);
  return (
    <div className="paraf-menu-anchor paraf-grow" ref={ref}>
      <button
        type="button"
        className="paraf-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={messages.chooseField}
        disabled={readOnly}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className={current ? undefined : 'paraf-mono'}>
          {current?.label ?? (props.value || messages.chooseField)}
        </span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="paraf-menu paraf-menu--wide">
          {variables.length > 0 && (
            <>
              <span className="paraf-menu__title">{messages.documentVariables}</span>
              <div role="listbox" aria-label={messages.chooseField}>
                {variables.map((variable) => (
                  <div
                    key={variable.key}
                    role="option"
                    tabIndex={0}
                    aria-selected={variable.key === props.value}
                    className="paraf-menu__item paraf-option"
                    onClick={() => {
                      setOpen(false);
                      props.onChange(variable.key, variable);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        setOpen(false);
                        props.onChange(variable.key, variable);
                      }
                    }}
                  >
                    <span className="paraf-menu__text">
                      <span className="paraf-menu__name">{variable.label ?? variable.key}</span>
                      <span className="paraf-mono paraf-hint">{variable.key}</span>
                    </span>
                    <span className={`paraf-chip paraf-chip--${variable.type}`}>
                      {messages.variableTypes[variable.type]}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          <form
            className="paraf-menu__custom"
            onSubmit={(event) => {
              event.preventDefault();
              setOpen(false);
              props.onChange(custom.trim());
            }}
          >
            <label className="paraf-field">
              <span className="paraf-field__label">{messages.customField}</span>
              <input
                type="text"
                className="paraf-mono"
                value={custom}
                placeholder={messages.customFieldPlaceholder}
                onChange={(event) => {
                  setCustom(event.target.value);
                }}
              />
            </label>
          </form>
        </div>
      )}
    </div>
  );
}

function ValueInput(props: {
  comparison: Comparison;
  variable: DocumentVariable | undefined;
  onChange: (value: Comparison['value']) => void;
}) {
  const { messages, readOnly } = useEditor();
  const { comparison, variable } = props;
  const label = messages.value;
  const [text, setDraft] = useDraftText(valueText(comparison.value), (draft) =>
    valueText(coerceValue(draft, comparison.valueType)),
  );
  if (comparison.valueType === 'boolean') {
    return (
      <select
        aria-label={label}
        value={String(comparison.value)}
        disabled={readOnly}
        onChange={(event) => {
          props.onChange(coerceValue(event.target.value, 'boolean'));
        }}
      >
        <option value="true">{messages.yes}</option>
        <option value="false">{messages.no}</option>
      </select>
    );
  }
  if (variable?.type === 'select' && comparison.valueType === 'text') {
    const options = variable.options ?? [];
    return (
      <select
        aria-label={label}
        value={String(comparison.value)}
        disabled={readOnly}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      >
        {!options.includes(String(comparison.value)) && (
          <option value={String(comparison.value)}>{String(comparison.value)}</option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={label}
      className="paraf-mono"
      type={
        comparison.valueType === 'number'
          ? 'number'
          : variable?.type === 'date' && comparison.valueType === 'text'
            ? 'date'
            : 'text'
      }
      title={comparison.valueType === 'list' ? messages.listHint : undefined}
      value={text}
      disabled={readOnly}
      onChange={(event) => {
        setDraft(event.target.value);
        props.onChange(coerceValue(event.target.value, comparison.valueType));
      }}
    />
  );
}

function ComparisonRow(props: {
  index: number;
  model: ConditionModel;
  comparison: Comparison;
  onChange: (comparison: Comparison) => void;
  onCombinator: (combinator: ConditionModel['combinator']) => void;
  onRemove: () => void;
}) {
  const { flow, messages, readOnly } = useEditor();
  const { comparison } = props;
  const variable = (flow.variables ?? []).find((item) => item.key === comparison.field);
  const set = (changes: Partial<Comparison>) => {
    props.onChange({ ...comparison, ...changes });
  };
  const valueTypes = comparison.operator === 'in' ? (['list'] as const) : VALUE_TYPES;

  return (
    <div className="paraf-comparison">
      {props.index === 0 ? (
        <span className="paraf-comparison__lead">{messages.if}</span>
      ) : (
        <select
          aria-label={`${messages.and} / ${messages.or}`}
          className="paraf-comparison__lead"
          value={props.model.combinator}
          disabled={readOnly}
          onChange={(event) => {
            props.onCombinator(event.target.value as ConditionModel['combinator']);
          }}
        >
          <option value="and">{messages.and}</option>
          <option value="or">{messages.or}</option>
        </select>
      )}
      <FieldPicker
        value={comparison.field}
        onChange={(field, picked) => {
          if (picked) {
            set(
              comparison.operator === 'in'
                ? { field }
                : { field, valueType: valueTypeOf(picked), value: initialValue(picked) },
            );
          } else {
            set({ field });
          }
        }}
      />
      <select
        aria-label={messages.operator}
        value={comparison.operator}
        disabled={readOnly}
        onChange={(event) => {
          const operator = event.target.value as Comparison['operator'];
          if (operator === 'in') set({ operator, valueType: 'list', value: [] });
          else if (comparison.valueType === 'list') {
            set({
              operator,
              valueType: variable ? valueTypeOf(variable) : 'text',
              value: variable ? initialValue(variable) : '',
            });
          } else set({ operator });
        }}
      >
        {COMPARISON_OPERATORS.map((operator) => (
          <option key={operator} value={operator}>
            {messages.operators[operator]}
          </option>
        ))}
      </select>
      {!variable && (
        <select
          aria-label={messages.variableType}
          value={comparison.valueType}
          disabled={readOnly}
          onChange={(event) => {
            const valueType = event.target.value as ValueType;
            set({ valueType, value: coerceValue(valueText(comparison.value), valueType) });
          }}
        >
          {valueTypes.map((type) => (
            <option key={type} value={type}>
              {messages.valueTypes[type]}
            </option>
          ))}
        </select>
      )}
      <ValueInput
        comparison={comparison}
        variable={variable}
        onChange={(value) => {
          set({ value });
        }}
      />
      <button
        type="button"
        className="paraf-button paraf-button--icon"
        aria-label={messages.remove}
        disabled={readOnly}
        onClick={props.onRemove}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

/**
 * Edits a rule's `when` expression as comparisons joined by and/or. Expressions the builder
 * cannot represent are shown read-only and kept untouched.
 */
export function ConditionBuilder(props: {
  value: ConditionExpression | undefined;
  onChange: (value: ConditionExpression) => void;
}) {
  const { messages, readOnly } = useEditor();
  const id = useId();
  const model = parseCondition(props.value);

  if (!model) {
    return (
      <div className="paraf-advanced">
        <p className="paraf-hint">{messages.advancedExpression}</p>
        <pre className="paraf-code">{JSON.stringify(props.value, null, 2)}</pre>
        <button
          type="button"
          className="paraf-button paraf-button--link"
          disabled={readOnly}
          onClick={() => {
            props.onChange(true);
          }}
        >
          {messages.replaceWithBuilder}
        </button>
      </div>
    );
  }

  const update = (next: ConditionModel) => {
    props.onChange(buildCondition(next));
  };

  return (
    <div className="paraf-condition" id={id}>
      {model.comparisons.length === 0 && <p className="paraf-hint">{messages.alwaysTrue}</p>}
      {model.comparisons.map((comparison, index) => (
        <ComparisonRow
          key={index}
          index={index}
          model={model}
          comparison={comparison}
          onChange={(next) => {
            update({
              ...model,
              comparisons: model.comparisons.map((item, i) => (i === index ? next : item)),
            });
          }}
          onCombinator={(combinator) => {
            update({ ...model, combinator });
          }}
          onRemove={() => {
            update({ ...model, comparisons: model.comparisons.filter((_item, i) => i !== index) });
          }}
        />
      ))}
      <button
        type="button"
        className="paraf-button paraf-button--link paraf-indent"
        disabled={readOnly}
        onClick={() => {
          update({
            ...model,
            comparisons: [
              ...model.comparisons,
              { field: '', operator: '==', valueType: 'text', value: '' },
            ],
          });
        }}
      >
        {messages.addComparison}
      </button>
    </div>
  );
}
