# @ida-dev/adapter-eventtarget

Records DOM `EventTarget` activity, including native events such as clicks and `dispatchEvent`, with handlers, timings, errors and cause. Part of [Ida](../../README.md).

```bash
npm install @ida-dev/core @ida-dev/adapter-eventtarget
```

## Setup

```ts
import { enable } from '@ida-dev/core';
import { enableEventTargetRecording } from '@ida-dev/adapter-eventtarget';

const recorder = enable();
const uninstall = enableEventTargetRecording(recorder, {
  label: (t) => (t === document ? 'Page' : undefined),
});
```

Your listeners behave exactly as before. Call `uninstall()` to stop recording.

## `enableEventTargetRecording(recorder?, options?)`

`recorder` defaults to the shared recorder from `enable()`. Returns an `Uninstall` function.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `include` | `(target) => boolean` | record all | Return `false` to leave a target unrecorded. |
| `label` | `(target) => string \| undefined` | `describeTarget` | Process label for a target. Return `undefined` to use the default. |

`describeTarget(target)` is exported: it gives `window`, `document`, `tag#id` / `tag.class`, or the constructor name.

## Only listeners added after setup are recorded

Call `enableEventTargetRecording` before your app registers listeners; ones added earlier are not recorded.

## Documentation

Quick starts, guides and the full API reference are in the **Docs** section of the Ida web app, and in the repo's [`docs/`](../../docs/overview.md) folder.
