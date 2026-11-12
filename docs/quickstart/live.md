# Watching live

You can watch events arrive while your app runs, in two ways:

| | Project live view | Local bridge |
| --- | --- | --- |
| Needs | `@ida-dev/cloud` and an ingest key | Only `@ida-dev/core`, in Node |
| Data goes | to the Ida server, and is kept as a recording | straight from your process to your browser; nothing is stored |
| Good for | apps running anywhere, teams | quick local debugging |

## Project live view

Once your app uploads to a project (see the [quick start](../quickstart.md)), open the project and click **Open viewer**. The viewer opens in **● Live** mode on every service in the project: the graph follows the newest events as they arrive, and the dot next to **Recording** in the inspector shows whether the stream is connected. It starts with the last 5 minutes.

Switch to **Replay** at the bottom to stop following and scrub through what has arrived so far. Switch back to **● Live** to follow again.

Use the menu in the graph's top-left corner, or double-click a service, to zoom into one service. See [Opening the viewer](../viewer/recordings.md).

## Local bridge

`startBridge` serves one recorder's events from your Node process over Server-Sent Events:

```js
import { enable } from '@ida-dev/core';
import { startBridge } from '@ida-dev/core/bridge-node';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

const recorder = enable();
enableEventEmitterRecording();
const bridge = await startBridge(recorder, { port: 7777 });
console.log(`Ida bridge on http://127.0.0.1:${bridge.port}`);

// later, when shutting down
await bridge.close();
```

In the viewer, open the recorder menu in the top-left corner, enter `http://127.0.0.1:7777` under **View Remote Endpoint** and click **Connect**. The viewer receives a snapshot of everything the recorder holds, then each new event as it happens. Choose **Disconnect** in the same menu to go back to the project's recordings.

> **Keep the bridge on loopback.** The stream carries your event data, including any full payloads, and anyone who can reach the port can read it. `host` defaults to `127.0.0.1`; don't change it to `0.0.0.0` on a machine others can reach.

`port: 0` picks a free port; read the one chosen from `bridge.port`. `startBridge` rejects if the port is already in use.

## Next steps

- [Replaying a recording](../viewer/replay.md)
- [`startBridge` reference](../reference/core.md#startbridge)
