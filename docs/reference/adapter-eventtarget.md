# @ida-dev/adapter-eventtarget

Records DOM `EventTarget` activity, including native events such as clicks and inputs, and `dispatchEvent`, with handlers, timings, errors and cause.

```bash
npm install @ida-dev/core @ida-dev/adapter-eventtarget
```

## enableEventTargetRecording

```ts
function enableEventTargetRecording(recorder?: Recorder, options?: EventTargetAdapterOptions): Uninstall
```

Patches `EventTarget.prototype.addEventListener`, `removeEventListener` and `dispatchEvent`. Listeners keep their platform behavior: `once`, `capture`, `passive`, `handleEvent` objects, and adding the same listener twice all work as before.

| Parameter | |
| --- | --- |
| `recorder` | Where to record. Leave it out to [route](../concepts/recorders.md#routing-which-recorder-records-an-event) each target to the recorders that `track()` it, or else to the default recorder. |
| `options` | See below. |

Returns a function that restores the original methods.

> **Only listeners added after setup are recorded.** Call `enableEventTargetRecording` before your app adds listeners, at the top of your entry module.

```js
import { connectRecorder } from '@ida-dev/core';
import { enableEventTargetRecording } from '@ida-dev/adapter-eventtarget';

const recorder = connectRecorder('page');
const uninstall = enableEventTargetRecording(recorder, {
  label: (t) => (t === document ? 'Page' : undefined),
});
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `include` | `(target: EventTarget) => boolean` | record all | Return `false` to leave a target unrecorded. Listeners on targets it rejects are never wrapped. |
| `label` | `(target: EventTarget) => string \| undefined` | `describeTarget` | The process label for a target. Return `undefined` to use the default. |
| `warnIfNoRecorder` | `boolean` | `true` | Print one console warning the first time an event has no recorder to go to. Ignored when you pass a recorder. |

## What is recorded for each event

| | |
| --- | --- |
| Event name | `event.type`. |
| Payload | For a `CustomEvent`, its `detail`. Otherwise whichever of `key`, `code`, `button`, `clientX`, `clientY`, `data`, `inputType` and `value` the event has, or nothing. |
| Handlers | Every recorded listener for that type on that target, in order. |
| Cause | An event dispatched inside a listener is caused by the event that listener is handling, such as a `click` handler dispatching `item:added`. |

## describeTarget

```ts
function describeTarget(target: EventTarget): string
```

The default process label: `window`, `document`, `tag#id`, `tag.firstClass`, the tag name, or the constructor name.

```js
describeTarget(document.querySelector('#checkout')); // 'button#checkout'
```

## Exports

| Export | |
| --- | --- |
| `enableEventTargetRecording` | See above. |
| `describeTarget` | See above. |
| `enable` | Re-exported from `@ida-dev/core`. |
| `Uninstall`, `EventTargetAdapterOptions` | Types. |
