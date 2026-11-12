# Navigating the graph

The viewer draws your app as a graph: **processes** and **handlers** are cards, and **pathways** between them are the routes events take. You zoom between levels of detail, and click anything to inspect it on the right.

## Zoom levels

| Level | Cards are | Use it to |
| --- | --- | --- |
| **Services** | One card per service (recorder), with Kafka topics and RabbitMQ exchanges and queues between them. The live project view opens here. | See how services talk. |
| **Processes** | Inside one service, one card per process: a group of emitters with the same label, such as `Orders` or `button#checkout`. | See which parts of your app talk to which. |
| **Handlers** | The handlers and emitters inside one process. Processes it talks to appear at the edge as small cards. | See exactly which handler emits what. |

- **Double-click** a card to zoom into it, or select it and use **Zoom into service** / **Zoom into process** in the inspector.
- The breadcrumb along the top of the graph (`Services › checkout › Payments`) shows where you are; click a level to go back up. The browser's **Back** button steps out too.
- A local file or bridge has no services level: it opens at its processes.
- Selecting a handler or an error from the inspector zooms to its process automatically.

Each card shows how busy it is. A card that briefly lights up with a **spike** saw a burst of events, held until the next update.

Use the controls in the graph's bottom-left corner, or scroll and drag, to zoom and pan the canvas itself.

## The inspector

The panel on the right shows whatever you select. Show or hide it with the tab on its edge, or press **I**. The trail at its top records how you got here (Overview › Payments › chargeCard › …); click a step to go back.

### Overview

With nothing selected:

- **Recording**: how many events are in the [replay window](replay.md#the-replay-window), out of the total, and, for live views, a dot showing whether the stream is connected.
- **Notifications**: every error and suspected corrupt payload in the window, ranked **critical**, **high**, **medium** or **low** (from confidence and whether an external system was reached). Click one to go to it.

### A process or handler

Click a card:

- **Process**, **Traffic**, and **Throws**: where it lives, how much it's doing, and how many errors it threw.
- **Activity** (handlers): how many events it handled and emitted, and the average time it took.
- **Rate**: events per second over time.
- **Receiving** / **Sending**: the events coming in and going out, with counts.
- For a handler, the **Activity** section lists its runs in the window, with an activity track you can click to move the playhead. Only runs that threw or carried a suspected corrupt payload are listed at first; tick **Show clean runs** to see all of them.
- A service's card also shows its **Runs** (restarts or instances in the window), **Runtime** (SDK and runtime version), and any **Clock** correction applied to it.
- Handlers and emitters [marked external](../guides/corruption.md#declaring-external-systems) carry a red **EXTERNAL** badge.

### A pathway

Click a line between cards:

- **Pathway**: the events that travel it and how often each fired.
- **Rate**: events per second.
- **Payloads**: the payloads that travelled it. Problems first; tick **Show clean payloads** for all.

### An event

Click an event name in any list:

- **Emitter**, **Fired** (in the window, and in total) and **Payload**: every payload shape this event has had. More than one shape is often the first clue.
- **Pathways** it travels, and **Recent notifications** for it.

### One occurrence

Click a single run, payload or step to see one occurrence of an event:

- **Emitted by**: the handler that was running, or the emitter for a root event.
- **Handlers**: every handler it reached, with how long each took and anything it threw.
- **Causality**: `sync`, `inferred (after an await or a timer)`, or `from another service, in a message header`. See [Events and causality](../concepts/events-and-causality.md).
- Broker facts for Kafka and RabbitMQ messages: topic, partition, offset, consumer group, exchange, routing key, queue, delivery tag. With a message from another service, **Published by** or **Consumed by** names the other side, and the time between them.
- **Causal chain**: the events that led here, back to the root. Click any to go there.
- **Trace**: light up this message's whole tree (see [Traces](traces-and-system.md#traces)).
- **Payload**: the values if the event was deep-logged (**full capture**), or its shape if not (**template-only**). For a suspected corrupt payload, a **Field / Before / Now** table shows what changed.

### An error

Click a red ✕ or an error notification:

- **Error**, and the event its handler was handling (**While handling**).
- **Corrupted payloads sent** after it, and how many reached external systems.
- **Propagated through**: where those payloads went next.

### A suspected corrupt payload

- Its severity, reasons, and the **Before / Now** comparison.
- **Recipients**: every handler and external system it reached.
- **Source error**: the failure that made its sender suspect, if any.

## Next steps

- [Services and traces](traces-and-system.md)
- [Suspected corrupt payloads](../guides/corruption.md)
