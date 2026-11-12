# Exporting recordings

You don't need a project to use Ida. A recorder can export what it holds as a JSON file that you open in the viewer, attach to a bug report, or process with your own scripts.

## Exporting

```js
import { writeFileSync } from 'node:fs';
import { getRecorder } from '@ida-dev/core';

writeFileSync('recording.json', JSON.stringify(getRecorder().export()));
```

```python
import json, ida
with open("recording.json", "w") as f:
    json.dump(ida.get_recorder().export(), f)
```

`export()` returns a snapshot of the recorder's window (see [Recorders](../concepts/recorders.md#the-window)): everything recorded in the last `windowMs`, up to `maxEvents`. It doesn't stop recording.

Common places to export:

```js
// When the process is about to exit
process.on('beforeExit', () => writeFileSync('recording.json', JSON.stringify(getRecorder().export())));

// From a test, after a failure
afterEach(function () {
  if (this.currentTest.state === 'failed') writeFileSync(`ida-${this.currentTest.title}.json`, JSON.stringify(getRecorder().export()));
  getRecorder().clear();
});

// In the browser, as a download
const blob = new Blob([JSON.stringify(recorder.export())], { type: 'application/json' });
const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'recording.json' });
a.click();
```

## Opening an export

In the viewer, click **Recordings** and use **Open file…**, or drop the file on the window. See [Opening the viewer](../viewer/recordings.md#from-a-file).

> **Note:** an export contains your emitter, event and handler names, error messages and stacks, and the full payloads of any deep-logged events. Check it before sharing it outside your team.

## What's in the file

A recording is plain JSON:

```json
{
  "version": 2,
  "startedAt": 1762857600000,
  "processes": [{ "id": "p1", "label": "Orders" }],
  "nodes": [
    { "id": "em1", "processId": "p1", "label": "Orders", "kind": "emitter" },
    { "id": "h1", "processId": "p1", "label": "chargeCard", "kind": "handler" }
  ],
  "templates": [
    { "id": "t1", "key": "…", "emitterId": "em1", "eventName": "order:placed", "handlerIds": ["h1"], "payloadShape": "{id:number,total:number}", "sampleCount": 6 }
  ],
  "occurrences": [
    {
      "id": "e1", "templateId": "t1", "parentId": null, "sourceNodeId": "em1",
      "ts": 12.4, "durationMs": 0.3, "capture": "template", "causality": "sync",
      "handlerResults": [{ "handlerId": "h1", "ts": 12.5, "durationMs": 0.2 }]
    }
  ],
  "findings": []
}
```

- `startedAt` is the wall-clock time the recorder started, in epoch milliseconds; every `ts` is milliseconds since then.
- Each occurrence points at its template (`templateId`), its cause (`parentId`), and the node that emitted it (`sourceNodeId`: a handler, or the emitter node for a root event).
- `capture: "full"` occurrences also have a `payload`.

Every field is described in the [recording format reference](../reference/recording-format.md).

## Reading recordings in code

The types are exported from `@ida-dev/core`:

```ts
import type { Recording } from '@ida-dev/core';
import { RECORDING_VERSION, analyze } from '@ida-dev/core';

const rec: Recording = JSON.parse(readFileSync('recording.json', 'utf8'));
if (rec.version > RECORDING_VERSION) throw new Error('recording from a newer Ida');

const templates = new Map(rec.templates.map((t) => [t.id, t]));
const failed = rec.occurrences.filter((o) => o.handlerResults.some((r) => r.error));
for (const o of failed) console.log(templates.get(o.templateId)!.eventName, o.handlerResults.find((r) => r.error)!.error!.message);

const findings = analyze(rec); // suspected corrupt payloads, after the fact
```

Version 2 is the current format; every version 1 recording is also valid version 2.
