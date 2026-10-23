import { useId, useState } from 'react';
import type {
  ApprovalChainNode,
  ApprovalNode,
  ApproverGroup,
  ConditionNode,
  ConditionRule,
  DuplicateApproverPolicy,
  EmptyApproversPolicy,
  EndNode,
  FlowNode,
  MultiGroupApprovalNode,
  SingleGroupApprovalNode,
} from '@paraf/core';
import { patchNode, useEditor } from '../context';
import { removeNodes, renameNode, replaceNode, updateFlow } from '../model/edit';
import { AddSourceButton, SourceCard, SourceList } from './ApproverEditor';
import { ConditionBuilder } from './ConditionBuilder';
import {
  Button,
  Field,
  NodeTargetSelect,
  NumberField,
  OptionalSelect,
  Section,
  Segmented,
  SelectField,
  TextField,
  Toggle,
} from './fields';
import { CloseIcon } from './icons';
import { GroupRulesFields, RequireField, TimeoutFields } from './RuleFields';
import { VariablesEditor } from './VariablesEditor';

const RULE_KEYS = [
  'approvers',
  'mode',
  'rejectPolicy',
  'excludeRequester',
  'onEmptyApprovers',
  'onInsufficientApprovers',
  'fallbackApprovers',
] as const;

/** Updates node `id` of the current flow. */
function useNodeUpdater(id: string) {
  const { flow, commit } = useEditor();
  return (node: FlowNode, coalesce?: string) => {
    commit(replaceNode(flow, id, node), coalesce && `${id}:${coalesce}`);
  };
}

/** Node type, ID (renamed on blur or Enter), and label. */
function NodeHead(props: { id: string; node: FlowNode }) {
  const { flow, commit, messages, readOnly, select } = useEditor();
  const update = useNodeUpdater(props.id);
  const idInput = useId();
  const [draft, setDraft] = useState(props.id);
  const [error, setError] = useState<string | undefined>();

  const rename = () => {
    const result = renameNode(flow, props.id, draft.trim());
    if ('error' in result) {
      setError(result.error === 'invalid' ? messages.nodeIdInvalid : messages.nodeIdTaken);
      return;
    }
    if (result.flow !== flow) {
      commit(result.flow);
      select(draft.trim());
    }
  };

  return (
    <div className="paraf-panel__head">
      <div className="paraf-panel__kind-row">
        <span className={`paraf-kind paraf-kind--${props.node.type}`}>
          {messages.nodeKind(messages.nodeTypes[props.node.type])}
        </span>
        <span className="paraf-id-field">
          <label htmlFor={idInput}>id:</label>
          <input
            id={idInput}
            aria-label={messages.nodeId}
            className="paraf-mono"
            value={draft}
            disabled={readOnly}
            size={Math.max(6, draft.length)}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') rename();
            }}
          />
        </span>
      </div>
      {error && (
        <small className="paraf-error" role="alert">
          {error}
        </small>
      )}
      <TextField
        label={messages.label}
        value={props.node.label ?? ''}
        onChange={(label) => {
          update(patchNode(props.node, { label: label === '' ? undefined : label }), 'label');
        }}
      />
    </div>
  );
}

/** Set as start / delete. */
function NodeActions(props: { id: string }) {
  const { flow, commit, messages, select } = useEditor();
  return (
    <div className="paraf-actions-row paraf-actions-row--spread">
      {flow.start === props.id ? (
        <span className="paraf-chip paraf-chip--dark">{messages.start}</span>
      ) : (
        <Button
          onClick={() => {
            commit(updateFlow(flow, { start: props.id }));
          }}
        >
          {messages.setAsStart}
        </Button>
      )}
      <Button
        variant="danger"
        onClick={() => {
          commit(removeNodes(flow, [props.id]));
          select(null);
        }}
      >
        {messages.deleteNode}
      </Button>
    </div>
  );
}

function DuplicateApproverField(props: {
  value: DuplicateApproverPolicy | undefined;
  onChange: (value: DuplicateApproverPolicy | undefined) => void;
}) {
  const { messages } = useEditor();
  return (
    <OptionalSelect<DuplicateApproverPolicy>
      label={messages.duplicateApprover}
      value={props.value}
      defaultLabel={messages.duplicatePolicies.require}
      options={(['require', 'auto-approve'] as const).map((value) => ({
        value,
        label: messages.duplicatePolicies[value],
      }))}
      onChange={props.onChange}
    />
  );
}

/** `next` and `onReject` of approval and chain nodes, plus node actions. */
function Connections(props: {
  id: string;
  node: ApprovalNode | ApprovalChainNode;
  update: (node: FlowNode) => void;
}) {
  const { messages } = useEditor();
  return (
    <Section title={messages.connections}>
      <NodeTargetSelect
        label={messages.next}
        value={props.node.next}
        exclude={props.id}
        onChange={(next) => {
          props.update(patchNode(props.node, { next }));
        }}
      />
      <NodeTargetSelect
        label={messages.onReject}
        value={props.node.onReject}
        exclude={props.id}
        onChange={(onReject) => {
          props.update(patchNode(props.node, { onReject }));
        }}
      />
      <NodeActions id={props.id} />
    </Section>
  );
}

function toGroups(node: SingleGroupApprovalNode): MultiGroupApprovalNode {
  const group: Record<string, unknown> = { id: 'group_1' };
  const rest: Record<string, unknown> = { ...node };
  for (const key of RULE_KEYS) {
    if (key in node) group[key] = node[key];
    Reflect.deleteProperty(rest, key);
  }
  return { ...rest, groups: [group] } as unknown as MultiGroupApprovalNode;
}

function toSingle(node: MultiGroupApprovalNode): SingleGroupApprovalNode {
  const { groups, require: _require, countAcrossGroups: _count, ...rest } = node;
  const { id: _id, label: _label, ...rules } = groups[0] ?? { approvers: [], mode: 'any' };
  return { ...rest, ...rules };
}

function GroupCard(props: {
  group: ApproverGroup;
  index: number;
  count: number;
  onChange: (group: ApproverGroup, coalesce?: string) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { messages } = useEditor();
  const { group, index } = props;
  return (
    <div className="paraf-card paraf-stack" role="group" aria-label={group.label ?? group.id}>
      <div className="paraf-section__header">
        <span className="paraf-strong">{group.label ?? group.id}</span>
        <span className="paraf-actions">
          <Button
            variant="icon"
            label={messages.moveUp}
            disabled={index === 0}
            onClick={() => {
              props.onMove(index - 1);
            }}
          >
            ↑
          </Button>
          <Button
            variant="icon"
            label={messages.moveDown}
            disabled={index === props.count - 1}
            onClick={() => {
              props.onMove(index + 1);
            }}
          >
            ↓
          </Button>
          <Button
            variant="icon"
            label={`${messages.remove} ${group.label ?? group.id}`}
            onClick={props.onRemove}
          >
            <CloseIcon size={14} />
          </Button>
        </span>
      </div>
      <div className="paraf-grid-2">
        <TextField
          label={messages.groupLabel}
          value={group.label ?? ''}
          onChange={(label) => {
            props.onChange(patchNode(group, { label: label === '' ? undefined : label }), 'label');
          }}
        />
        <TextField
          label={messages.groupId}
          mono
          value={group.id}
          onChange={(id) => {
            props.onChange({ ...group, id }, 'id');
          }}
        />
      </div>
      <GroupRulesFields rules={group} withExcludeRequester onChange={props.onChange} />
    </div>
  );
}

function GroupsSection(props: {
  node: MultiGroupApprovalNode;
  update: (node: FlowNode, coalesce?: string) => void;
}) {
  const { messages, readOnly } = useEditor();
  const { node } = props;
  const setGroups = (groups: ApproverGroup[], coalesce?: string) => {
    props.update({ ...node, groups }, coalesce);
  };
  return (
    <Section
      title={messages.approverGroups}
      aside={<span className="paraf-hint">{messages.groupCount(node.groups.length)}</span>}
    >
      <RequireField
        value={node.require}
        onChange={(require) => {
          props.update(patchNode(node, { require }));
        }}
      />
      {node.groups.map((group, index) => (
        <GroupCard
          key={index}
          group={group}
          index={index}
          count={node.groups.length}
          onChange={(next, coalesce) => {
            setGroups(
              node.groups.map((g, i) => (i === index ? next : g)),
              coalesce && `group.${index}.${coalesce}`,
            );
          }}
          onMove={(to) => {
            const groups = [...node.groups];
            const [moved] = groups.splice(index, 1);
            groups.splice(to, 0, moved as ApproverGroup);
            setGroups(groups);
          }}
          onRemove={() => {
            setGroups(node.groups.filter((_g, i) => i !== index));
          }}
        />
      ))}
      <button
        type="button"
        className="paraf-button paraf-button--dashed"
        disabled={readOnly}
        onClick={() => {
          let n = node.groups.length + 1;
          while (node.groups.some((group) => group.id === `group_${n}`)) n++;
          setGroups([...node.groups, { id: `group_${n}`, approvers: [], mode: 'any' }]);
        }}
      >
        {messages.addGroup}
      </button>
      <button
        type="button"
        className="paraf-button paraf-button--link"
        disabled={readOnly}
        onClick={() => {
          props.update(toSingle(node));
        }}
      >
        {messages.mergeGroups}
      </button>
    </Section>
  );
}

export function ApprovalPanel(props: { id: string; node: ApprovalNode }) {
  const { messages, readOnly } = useEditor();
  const update = useNodeUpdater(props.id);
  const { node } = props;
  return (
    <>
      <NodeHead id={props.id} node={node} />
      {node.groups ? (
        <GroupsSection node={node} update={update} />
      ) : (
        <Section
          title={messages.approvers}
          aside={
            <button
              type="button"
              className="paraf-button paraf-button--link"
              disabled={readOnly}
              onClick={() => {
                update(toGroups(node));
              }}
            >
              {messages.splitIntoGroups}
            </button>
          }
        >
          <GroupRulesFields rules={node} onChange={update} />
        </Section>
      )}
      <Section title={messages.advanced}>
        {node.groups ? (
          <Toggle
            label={messages.countAcrossGroups}
            value={node.countAcrossGroups}
            defaultValue
            onChange={(countAcrossGroups) => {
              update(patchNode(node, { countAcrossGroups }));
            }}
          />
        ) : (
          <Toggle
            label={messages.excludeRequester}
            value={node.excludeRequester}
            defaultValue={false}
            onChange={(excludeRequester) => {
              update(patchNode(node, { excludeRequester }));
            }}
          />
        )}
        <DuplicateApproverField
          value={node.duplicateApprover}
          onChange={(duplicateApprover) => {
            update(patchNode(node, { duplicateApprover }));
          }}
        />
        <TimeoutFields
          value={node.timeout}
          onChange={(timeout, coalesce) => {
            update(patchNode(node, { timeout }), coalesce);
          }}
        />
      </Section>
      <Connections id={props.id} node={node} update={update} />
    </>
  );
}

export function ChainPanel(props: { id: string; node: ApprovalChainNode }) {
  const { chains, flow, messages } = useEditor();
  const update = useNodeUpdater(props.id);
  const listId = useId();
  const { node } = props;
  const set = (changes: Record<string, unknown>, coalesce?: string) => {
    update(patchNode(node, changes), coalesce);
  };
  const chainOptions = chains.map((chain) => ({ value: chain.name, label: chain.label }));
  if (node.chain && !chains.some((chain) => chain.name === node.chain)) {
    chainOptions.push({ value: node.chain, label: `${node.chain} (?)` });
  }
  const userVariables = (flow.variables ?? []).filter((variable) => variable.type === 'user');
  const fromField = typeof node.from === 'object' ? node.from.field : null;

  return (
    <>
      <NodeHead id={props.id} node={node} />
      <Section title={messages.reportingLine}>
        <SelectField
          label={messages.chain}
          value={node.chain}
          options={[{ value: '', label: messages.none }, ...chainOptions]}
          onChange={(chain) => {
            set({ chain: chain === '' ? undefined : chain });
          }}
        />
        <OptionalSelect<'requester' | 'field'>
          label={messages.from}
          value={
            node.from === undefined
              ? undefined
              : typeof node.from === 'object'
                ? 'field'
                : 'requester'
          }
          defaultLabel={messages.fromRequester}
          options={[
            { value: 'requester', label: messages.fromRequester },
            { value: 'field', label: messages.fromField },
          ]}
          onChange={(from) => {
            set({ from: from === 'field' ? { field: userVariables[0]?.key ?? '' } : from });
          }}
        />
        {fromField !== null && (
          <Field label={messages.fieldPath}>
            {(id) => (
              <>
                <input
                  id={id}
                  className="paraf-mono"
                  list={listId}
                  value={fromField}
                  onChange={(event) => {
                    set({ from: { field: event.target.value } }, 'from');
                  }}
                />
                <datalist id={listId}>
                  {userVariables.map((variable) => (
                    <option key={variable.key} value={variable.key}>
                      {variable.label ?? variable.key}
                    </option>
                  ))}
                </datalist>
              </>
            )}
          </Field>
        )}
        <div className="paraf-field">
          <span className="paraf-field__label">{messages.until}</span>
          {node.until ? (
            <SourceCard
              entry={node.until}
              onChange={(until) => {
                set({ until });
              }}
              onRemove={() => {
                set({ until: undefined });
              }}
            />
          ) : (
            <AddSourceButton
              label={messages.addUntil}
              onSelect={(type) => {
                set({ until: { type } });
              }}
            />
          )}
        </div>
        <Toggle
          label={messages.includeStopper}
          value={node.includeStopper}
          defaultValue
          onChange={(includeStopper) => {
            set({ includeStopper });
          }}
        />
        <NumberField
          label={messages.maxLevels}
          min={1}
          value={node.maxLevels}
          onChange={(maxLevels) => {
            set({ maxLevels }, 'maxLevels');
          }}
        />
      </Section>
      <Section title={messages.advanced}>
        <DuplicateApproverField
          value={node.duplicateApprover}
          onChange={(duplicateApprover) => {
            set({ duplicateApprover });
          }}
        />
        <Toggle
          label={messages.excludeRequester}
          value={node.excludeRequester}
          defaultValue={false}
          onChange={(excludeRequester) => {
            set({ excludeRequester });
          }}
        />
        <OptionalSelect<EmptyApproversPolicy>
          label={messages.onEmptyChain}
          value={node.onEmptyApprovers}
          defaultLabel={messages.emptyPolicies.error}
          options={(['error', 'skip', 'fallback'] as const).map((value) => ({
            value,
            label: messages.emptyPolicies[value],
          }))}
          onChange={(onEmptyApprovers) => {
            set({ onEmptyApprovers });
          }}
        />
        {(node.onEmptyApprovers === 'fallback' || node.fallbackApprovers !== undefined) && (
          <SourceList
            label={messages.fallbackApprovers}
            entries={node.fallbackApprovers}
            onChange={(fallbackApprovers) => {
              set({ fallbackApprovers });
            }}
          />
        )}
        <TimeoutFields
          value={node.timeout}
          onChange={(timeout, coalesce) => {
            set({ timeout }, coalesce);
          }}
        />
      </Section>
      <Connections id={props.id} node={node} update={update} />
    </>
  );
}

export function ConditionPanel(props: { id: string; node: ConditionNode }) {
  const { messages, readOnly } = useEditor();
  const update = useNodeUpdater(props.id);
  const { node } = props;
  const rules = Array.isArray(node.rules) ? node.rules : [];
  const setRules = (next: ConditionRule[], coalesce?: string) => {
    update({ ...node, rules: next }, coalesce);
  };
  const setRule = (index: number, rule: ConditionRule, coalesce?: string) => {
    setRules(
      rules.map((item, i) => (i === index ? rule : item)),
      coalesce && `rule.${index}.${coalesce}`,
    );
  };
  return (
    <>
      <NodeHead id={props.id} node={node} />
      <Section
        title={messages.rules}
        aside={<span className="paraf-hint">{messages.rulesOrder}</span>}
      >
        {rules.map((rule, index) => (
          <div
            key={index}
            className="paraf-card paraf-card--rule paraf-stack"
            role="group"
            aria-label={messages.rule(index)}
          >
            <div className="paraf-section__header">
              <span className="paraf-rule-title">{messages.rule(index)}</span>
              <Button
                variant="icon"
                label={`${messages.remove} ${messages.rule(index)}`}
                onClick={() => {
                  setRules(rules.filter((_rule, i) => i !== index));
                }}
              >
                <CloseIcon size={14} />
              </Button>
            </div>
            <TextField
              label={messages.ruleName}
              value={rule.label ?? ''}
              onChange={(label) => {
                setRule(
                  index,
                  patchNode(rule, { label: label === '' ? undefined : label }),
                  'label',
                );
              }}
            />
            <ConditionBuilder
              value={rule.when}
              onChange={(when) => {
                setRule(index, { ...rule, when }, 'when');
              }}
            />
            <NodeTargetSelect
              label={messages.goTo}
              value={rule.next}
              exclude={props.id}
              onChange={(next) => {
                setRule(index, patchNode(rule, { next }));
              }}
            />
          </div>
        ))}
        <button
          type="button"
          className="paraf-button paraf-button--dashed"
          disabled={readOnly}
          onClick={() => {
            setRules([...rules, { when: true } as ConditionRule]);
          }}
        >
          {messages.addRule}
        </button>
        <div className="paraf-card paraf-card--muted paraf-stack">
          <span className="paraf-strong paraf-small">{messages.otherwise}</span>
          <NodeTargetSelect
            label={messages.goTo}
            value={node.else}
            exclude={props.id}
            onChange={(target) => {
              update(patchNode(node, { else: target }));
            }}
          />
        </div>
        <details className="paraf-json">
          <summary>{messages.viewJson}</summary>
          <pre>{JSON.stringify({ rules: node.rules, else: node.else }, null, 2)}</pre>
        </details>
      </Section>
      <Section>
        <NodeActions id={props.id} />
      </Section>
    </>
  );
}

export function EndPanel(props: { id: string; node: EndNode }) {
  const { messages } = useEditor();
  const update = useNodeUpdater(props.id);
  return (
    <>
      <NodeHead id={props.id} node={props.node} />
      <Section>
        <Segmented
          label={messages.result}
          value={props.node.result}
          options={[
            { value: 'approved', label: messages.resultApproved },
            { value: 'rejected', label: messages.resultRejected },
          ]}
          onChange={(result) => {
            update({ ...props.node, result });
          }}
        />
        <NodeActions id={props.id} />
      </Section>
    </>
  );
}

export function FlowSettingsPanel() {
  const { flow, commit, messages } = useEditor();
  return (
    <>
      <div className="paraf-panel__head">
        <span className="paraf-kind paraf-kind--flow">{messages.flowSettings}</span>
        <TextField
          label={messages.flowName}
          value={flow.name}
          onChange={(name) => {
            commit(updateFlow(flow, { name }), 'flow.name');
          }}
        />
        <TextField
          label={messages.flowId}
          mono
          hint={messages.flowIdHint(flow.id)}
          value={flow.id}
          onChange={(id) => {
            commit(updateFlow(flow, { id }), 'flow.id');
          }}
        />
        <NodeTargetSelect
          label={messages.startNode}
          value={flow.start || undefined}
          onChange={(start) => {
            commit(updateFlow(flow, { start: start ?? '' }));
          }}
        />
        <OptionalSelect<'restart' | 'resume'>
          label={messages.resubmitPolicy}
          value={flow.resubmitPolicy}
          defaultLabel={messages.resubmitPolicies.restart}
          options={(['restart', 'resume'] as const).map((value) => ({
            value,
            label: messages.resubmitPolicies[value],
          }))}
          onChange={(resubmitPolicy) => {
            commit(updateFlow(flow, { resubmitPolicy }));
          }}
        />
      </div>
      <Section>
        <VariablesEditor />
      </Section>
    </>
  );
}

/** The side panel: settings of the selected node, or of the flow. */
export function PropertiesPanel() {
  const { flow, messages, selectedNodeId } = useEditor();
  const node = selectedNodeId === null ? undefined : flow.nodes[selectedNodeId];
  const id = selectedNodeId as string;
  let content;
  if (!node) content = <FlowSettingsPanel />;
  else if (node.type === 'approval') content = <ApprovalPanel key={id} id={id} node={node} />;
  else if (node.type === 'approval-chain') content = <ChainPanel key={id} id={id} node={node} />;
  else if (node.type === 'condition') content = <ConditionPanel key={id} id={id} node={node} />;
  else content = <EndPanel key={id} id={id} node={node} />;
  return (
    <aside
      className="paraf-panel"
      aria-label={node ? messages.nodeKind(messages.nodeTypes[node.type]) : messages.flowSettings}
    >
      {content}
    </aside>
  );
}
