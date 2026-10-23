# @paraf/editor

Visual flow editor for [Paraf](../../README.md), as a React component (React 18+, built on
[React Flow](https://reactflow.dev)). Admins build approval flows like a diagram; every change is
checked with the same `validateFlow` the engine uses. Also includes a read-only progress view of
one running approval.

> [!WARNING]
> Early development. The API may still change before `1.0.0`.

Embed it in your own admin pages with this package, or use
[Paraf Studio](../studio/README.md) for a ready-made app around it.

Requires React 18 or newer.

```sh
npm install @paraf/core @paraf/editor react react-dom
```

## Edit a flow

```tsx
import { useState } from 'react';
import type { FlowDefinition } from '@paraf/core';
import { ParafEditor } from '@paraf/editor';
import '@paraf/editor/style.css';

export function FlowPage({ initial, approverTypes, chains, operators, active, latest }: Props) {
  const [flow, setFlow] = useState<FlowDefinition>(initial);
  return (
    <div style={{ height: '100vh' }}>
      <ParafEditor
        value={flow}
        onChange={setFlow}
        approverTypes={approverTypes} // engine.getApproverTypes(), sent from your server
        chains={chains} //               engine.getChains()
        operators={operators} //       engine.getOperators()
        publish={{
          activeVersion: active?.version ?? null,
          latestVersion: latest, //    after a rollback the next version follows the latest one
          activeFlow: active, //       to list the changes since the active version
          target: 'PRODUCTION', //     optional: shown in the publish dialog
          onPublish: (draft, notes) => api.publishFlow(draft, notes), // engine.publishFlow on the server
        }}
      />
    </div>
  );
}
```

The editor is controlled: it never stores the flow, it calls `onChange` with a new one. It fills
its container, so give the container a height.

- **Adding nodes:** drag from the palette, click a palette item, press **+** below a node (the new
  node is already connected), or start an empty flow from a template.
- **Connecting:** drag from a handle (bottom: next / else, right: reject / rule) to a node, or
  pick targets in the side panel. Select an edge or node and press Delete to remove it.
- **Side panel:** every setting of the selected node; with nothing selected, the flow settings
  and its [document variables](../core/README.md#document-variables), which conditions and
  approver settings then offer by name.
- **Validation:** the status bar shows problems; their numbers also appear on the nodes.
- **Undo / redo:** buttons or Ctrl/⌘+Z, Ctrl/⌘+Y.
- **Import / Export JSON**, and **Publish** with the changes since the active version.

Settings left at their default stay out of the JSON, and the editor keeps what it cannot
display (such as condition expressions too complex for the rule builder), so importing and
exporting a flow does not change it.

| Prop            | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `value`         | The flow (`FlowDefinition`).                                             |
| `onChange`      | Called with the new flow after every edit.                               |
| `approverTypes` | Approver types and their setting forms; `user` and `field` are built in. |
| `chains`        | Chains for approval-chain nodes.                                         |
| `operators`     | Custom condition operators registered on the engine (for validation).    |
| `readOnly`      | Show the flow without allowing changes.                                  |
| `onValidate`    | Called with the validation issues whenever they change.                  |
| `publish`       | Adds the Publish button, version badges, and the publish dialog.         |
| `headerStart`   | Rendered at the start of the header (your logo, breadcrumbs).            |
| `messages`      | Replaces texts, for example a translation; see `defaultMessages`.        |

## Show an approval's progress

```tsx
import { ParafProgress } from '@paraf/editor';

<ParafProgress
  flow={await engine.getFlow(instance.flowId, instance.flowVersion)}
  state={await engine.getInstance(instance.id)}
  history={await engine.getHistory(instance.id)}
  userName={(id) => users[id]?.name ?? id}
/>;
```

Steps that are done, waiting (with who approved so far, per level or group), rejected, or not
reached yet, the path taken, the document's variables, and the history.

## Styling and text

Import `@paraf/editor/style.css` once. Colors, fonts and radii are CSS variables (`--paraf-*`)
on `.paraf-editor`; override them in your stylesheet. The design uses
[IBM Plex Sans and IBM Plex Mono](https://fonts.google.com/?query=IBM+Plex) when your page loads
them, and falls back to system fonts otherwise.

All text is English by default. Pass `messages` with the keys to replace:

```tsx
<ParafEditor messages={{ flowValid: 'Alur valid', publish: 'Terbitkan' }} {...props} />
```
