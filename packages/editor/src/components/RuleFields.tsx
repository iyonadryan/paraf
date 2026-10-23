import type {
  ApprovalMode,
  ApproverGroupRules,
  EmptyApproversPolicy,
  GroupRequirement,
  InsufficientApproversPolicy,
  TimeoutConfig,
} from '@paraf/core';
import { patchNode, useEditor } from '../context';
import { SourceList } from './ApproverEditor';
import { NumberField, OptionalSelect, Segmented, TextField, Toggle } from './fields';

/** "Any 1 / All / At least n" plus n. */
export function ModeField(props: {
  value: ApprovalMode | undefined;
  onChange: (mode: ApprovalMode) => void;
}) {
  const { messages } = useEditor();
  const kind = typeof props.value === 'object' ? 'minimum' : (props.value ?? 'any');
  return (
    <div className="paraf-row">
      <Segmented
        label={messages.howManyApprove}
        value={kind}
        options={[
          { value: 'any', label: messages.modeAnyButton },
          { value: 'all', label: messages.modeAllButton },
          { value: 'minimum', label: messages.modeMinimumButton },
        ]}
        onChange={(value) => {
          props.onChange(value === 'minimum' ? { minimum: 2 } : value);
        }}
      />
      {typeof props.value === 'object' && (
        <NumberField
          label={messages.minimumN}
          min={1}
          compact
          value={props.value.minimum}
          onChange={(minimum) => {
            props.onChange({ minimum: minimum ?? 1 });
          }}
        />
      )}
    </div>
  );
}

/**
 * An optional setting that is one of some names or `{ minimum: n }` (`rejectPolicy`,
 * `require`).
 */
export function MinimumPolicyField<T extends string>(props: {
  label: string;
  value: T | { minimum: number } | undefined;
  defaultLabel: string;
  options: readonly { value: T; label: string }[];
  minimumLabel: string;
  numberLabel: string;
  onChange: (value: T | { minimum: number } | undefined) => void;
}) {
  const kind = typeof props.value === 'object' ? 'minimum' : props.value;
  return (
    <div className="paraf-row">
      <OptionalSelect<string>
        label={props.label}
        value={kind}
        defaultLabel={props.defaultLabel}
        options={[...props.options, { value: 'minimum', label: props.minimumLabel }]}
        onChange={(value) => {
          props.onChange(value === 'minimum' ? { minimum: 1 } : (value as T | undefined));
        }}
      />
      {typeof props.value === 'object' && (
        <NumberField
          label={props.numberLabel}
          min={1}
          compact
          value={props.value.minimum}
          onChange={(minimum) => {
            props.onChange({ minimum: minimum ?? 1 });
          }}
        />
      )}
    </div>
  );
}

/** Approvers and the rules applied to them, for one group (or a single-group node). */
export function GroupRulesFields<T extends Partial<ApproverGroupRules>>(props: {
  rules: T;
  onChange: (rules: T, coalesce?: string) => void;
  /** Show "exclude the requester" here (groups) rather than under Advanced (single group). */
  withExcludeRequester?: boolean;
}) {
  const { messages } = useEditor();
  const { rules } = props;
  const set = (changes: Record<string, unknown>, coalesce?: string) => {
    props.onChange(patchNode(rules as Record<string, unknown>, changes) as T, coalesce);
  };
  const usesFallback =
    rules.onEmptyApprovers === 'fallback' || rules.onInsufficientApprovers === 'fallback';

  return (
    <>
      <ModeField
        value={rules.mode}
        onChange={(mode) => {
          set({ mode });
        }}
      />
      <SourceList
        label={messages.approvers}
        entries={rules.approvers}
        emptyHint={messages.sourcesHint}
        onChange={(approvers) => {
          set({ approvers });
        }}
      />
      <MinimumPolicyField<'any' | 'impossible'>
        label={messages.rejectPolicy}
        value={rules.rejectPolicy}
        defaultLabel={
          typeof rules.mode === 'object'
            ? messages.rejectPolicies.impossible
            : messages.rejectPolicies.any
        }
        options={[
          { value: 'any', label: messages.rejectPolicies.any },
          { value: 'impossible', label: messages.rejectPolicies.impossible },
        ]}
        minimumLabel={messages.rejectPolicies.minimum}
        numberLabel={messages.rejectMinimum}
        onChange={(rejectPolicy) => {
          set({ rejectPolicy });
        }}
      />
      {typeof rules.mode === 'object' && (
        <OptionalSelect<InsufficientApproversPolicy>
          label={messages.onInsufficientApprovers}
          value={rules.onInsufficientApprovers}
          defaultLabel={messages.insufficientPolicies.error}
          options={(['error', 'cap', 'fallback'] as const).map((value) => ({
            value,
            label: messages.insufficientPolicies[value],
          }))}
          onChange={(onInsufficientApprovers) => {
            set({ onInsufficientApprovers });
          }}
        />
      )}
      <OptionalSelect<EmptyApproversPolicy>
        label={messages.onEmptyApprovers}
        value={rules.onEmptyApprovers}
        defaultLabel={messages.emptyPolicies.error}
        options={(['error', 'skip', 'fallback'] as const).map((value) => ({
          value,
          label: messages.emptyPolicies[value],
        }))}
        onChange={(onEmptyApprovers) => {
          set({ onEmptyApprovers });
        }}
      />
      {(usesFallback || rules.fallbackApprovers !== undefined) && (
        <SourceList
          label={messages.fallbackApprovers}
          entries={rules.fallbackApprovers}
          onChange={(fallbackApprovers) => {
            set({ fallbackApprovers });
          }}
        />
      )}
      {props.withExcludeRequester && (
        <Toggle
          label={messages.excludeRequester}
          value={rules.excludeRequester}
          defaultValue={false}
          onChange={(excludeRequester) => {
            set({ excludeRequester });
          }}
        />
      )}
    </>
  );
}

/** `require` between parallel groups. */
export function RequireField(props: {
  value: GroupRequirement | undefined;
  onChange: (value: GroupRequirement | undefined) => void;
}) {
  const { messages } = useEditor();
  return (
    <MinimumPolicyField<'all' | 'any'>
      label={messages.nodeCompletesWhen}
      value={props.value}
      defaultLabel={messages.requireOptions.all}
      options={[
        { value: 'all', label: messages.requireOptions.all },
        { value: 'any', label: messages.requireOptions.any },
      ]}
      minimumLabel={messages.requireOptions.minimum}
      numberLabel={messages.minimumN}
      onChange={props.onChange}
    />
  );
}

/** Optional escalation timeout. */
export function TimeoutFields(props: {
  value: TimeoutConfig | undefined;
  onChange: (value: TimeoutConfig | undefined, coalesce?: string) => void;
}) {
  const { messages } = useEditor();
  const timeout = props.value;
  return (
    <div className="paraf-stack">
      <Toggle
        label={messages.timeout}
        value={timeout !== undefined}
        defaultValue={false}
        onChange={(on) => {
          props.onChange(on ? { after: 'P3D', action: 'escalate', to: [] } : undefined);
        }}
      />
      {timeout && (
        <div className="paraf-card paraf-stack">
          <TextField
            label={messages.timeoutAfter}
            hint={messages.timeoutAfterHint}
            mono
            value={timeout.after}
            onChange={(after) => {
              props.onChange({ ...timeout, after }, 'timeout.after');
            }}
          />
          <SourceList
            label={messages.escalateTo}
            entries={timeout.to}
            onChange={(to) => {
              props.onChange({ ...timeout, to });
            }}
          />
        </div>
      )}
    </div>
  );
}
