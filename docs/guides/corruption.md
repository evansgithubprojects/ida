# Suspected corrupt payloads

A handler throws halfway through, leaves an object half-updated, and keeps emitting. Downstream handlers receive payloads that look normal but aren't, and the bug surfaces far from its cause. Ida watches for this: after a failure, it compares what the failing handler or emitter sends next with what it sent before, and flags payloads that look wrong.

Findings always say **suspected**: Ida can't know your data's rules, only that a payload differs from earlier ones in a way that often means trouble.

> This feature is in the JavaScript SDK only. The Python SDK records errors but doesn't flag payloads.

## How detection works

1. **A failure taints its source.** When a handler throws, or an `error` event is emitted with an `Error`, that handler (or emitter) becomes suspect, for `taintWindowMs` (1 s) or its next `taintCount` (5) emits, whichever ends first.
2. **Its next payloads are compared with earlier clean ones** of the same event from the same emitter. Up to 20 earlier samples are kept.
3. **Flagged payloads taint what they cause**, for `taintDepth` (1) hop, so a bad payload passed along is caught one step further.
4. **Payloads emitted before the failure** (in the same handler run) are checked again once it fails, and flagged as *retroactive*.

With [deep logging](../concepts/templates.md#keeping-full-payloads) on for the event, values are compared (basis **deep**). Without it, only shapes are (basis **shape**), which catches fields that disappear or change type but not bad values.

With `detectUntainted` (on by default), Ida also flags payloads that no failure points to, after it has seen at least 3 clean ones of that event. These are held to a stricter bar: a shape change alone isn't enough without a bad value.

### What is flagged

| Reason | Means |
| --- | --- |
| `missing-field` | A field present in earlier payloads is gone. |
| `bad-value` | A value is `NaN`, `Infinity`, `undefined` or `null` where earlier payloads had real data. |
| `type-change` | A field changed type (`number` → `string`). |
| `empty-value` | A field is empty (such as `''` or `[]`) but never was before. |
| `outlier` | A number far outside the earlier range (needs 5 samples). |
| `format-change` | An id-like field (`id`, `uuid`, `key`…) changed format. |
| `stale-payload` | The payload is identical to an earlier one when it normally changes (needs 3 samples). |
| `shape-changed` | Shape-only: the payload's shape differs from earlier ones. |

### Confidence and priority

Each finding has a **confidence** (`high`, `medium` or `low`), from how many reasons it has and how strong they are, capped when there are few earlier samples. Shape-only findings are always low; untainted findings are at most medium.

Its **priority** is `high` when the payload is headed for an **external system** (an HTTP API, a database, a third party), where damage is hardest to undo, and `normal` otherwise. The viewer ranks findings into critical, high, medium and low from both.

## Declaring external systems

Ida can't see inside a handler, so tell it which handlers, emitters or events reach the outside world:

```js
enable({
  corruption: {
    external: {
      handlers: [postToBillingApi, saveOrder],
      emitters: [webhookBus],
      events: ['invoice:send'], // or (eventName, emitterLabel) => boolean
    },
  },
});

// or later, from anywhere
getRecorder().markExternal(postToBillingApi); // a handler
getRecorder().markExternal(webhookBus);       // an emitter
```

In the viewer, these carry a red **EXTERNAL** badge, and findings reaching them are ranked higher.

## Being told

Findings are always recorded and shown in the viewer: as ticks on the timeline, in the inspector's **Notifications**, and on the payloads themselves. To be told as they happen:

```js
enable({
  corruption: {
    notify: 'console',                     // console.warn, or console.error for high priority
    // notify: (finding) => alert(finding),   // your own function
    // notify: ['console', sendToSlack],      // both
  },
});
```

Console output looks like:

```
[ida] HIGH PRIORITY medium confidence: EXTERNAL (postToBillingApi) suspected corrupt payload for Orders → order:confirmed: total is NaN, was number
```

When `notify` is set at all, high-priority findings are also printed with `console.error`, even if it doesn't include `'console'`.

## Blocking

With `policy: 'block'`, a flagged emit throws `SuspectedCorruptionError` instead of calling any handler. Use `externalPolicy` to block only what is headed for an external system:

```js
import { SuspectedCorruptionError } from '@ida-dev/core';

enable({
  corruption: {
    external: { handlers: [postToBillingApi] },
    policy: 'notify',        // internal: just report
    externalPolicy: 'block', // external: stop it
  },
});

try {
  orders.emit('invoice:send', invoice);
} catch (err) {
  if (err instanceof SuspectedCorruptionError) console.error('blocked', err.finding);
  else throw err;
}
```

The blocked occurrence is recorded with `blocked: true`.

> **Warning:** blocking changes your app's behavior based on a heuristic. Start with `'notify'`, check what gets flagged on real traffic, and only then block, and preferably only external targets.

## Checking a recording after the fact

`analyze` runs the same rules over an exported recording, in time order:

```js
import { analyze } from '@ida-dev/core';
const findings = analyze(JSON.parse(readFileSync('recording.json', 'utf8')), { taintWindowMs: 5000 });
```

It takes the same detection options as `corruption`. Values are compared only for occurrences that were deep-logged.

## Options

See [`CorruptionOptions`](../reference/core.md#corruptionoptions) for every option and its default.
