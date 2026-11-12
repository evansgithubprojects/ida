# Services and traces

When your app is several services talking through Kafka or RabbitMQ, the viewer shows them together and lets you follow one message through all of them. This page covers the services level and traces.

## Services

The live project view opens on every service at once:

- Each **service** card is one recorder key (`checkout`, `payments`, `notifier`). Several runs of it in the time shown (restarts, or several instances) are one card.
- **Topics**, **exchanges** and **queues** sit between the services that use them, shared by every service that produces to or consumes from them.
- **Dotted pathways** carry messages from one service to another, linked by the `ida-parent` header (see [Tracing messages across services](../guides/brokers.md)).

Double-click a service to zoom into its processes, and a process to zoom into its handlers. Inside a service, the other services it exchanges messages with appear as small cards at the edge, marked *other service*, so you can still see where its messages come from and go.

Select a service's card to see its **Runs** in view, the **Runtime** and SDK version each ran on, and any **Clock** correction (below).

### Clocks

Each service timestamps its own events. The server estimates each service's clock offset when it uploads and puts all services on one clock, so messages play back in order. If a message still appears consumed before it was published, the viewer moves the consuming service's events later by the smallest amount that fixes it (the order within the service doesn't change), shows the correction on the service's card, and marks the message with a **clock skew** badge.

### Missing publishers

A message whose header names a publish Ida has no record of (the sender doesn't record with Ida, or its events are outside the time in view) is still shown, and a banner counts how many there are.

## Traces

A **trace** lights up one message's whole story: everything that led to it, back to the root, and everything it caused, across services and brokers. The rest of the graph fades.

To start one, select any event or occurrence and press **T**, or click **Trace** in the inspector.

The trace bar lists every step, oldest first:

- each step's **service** (shown when it changes), and, for broker hops, the **topic, exchange or queue** and how long the message waited there;
- the event and the handler that handled it;
- its time from the start of the trace;
- a red ✕ and message on steps whose handler threw. The bar's header names the service with the **first error**, usually the place to start reading.

Click a step to jump to it: the playhead moves there and the graph zooms as needed. The trace's steps are also marked on the timeline, so you can scrub between them. Press **Esc** or click **✕** to end the trace.

If some steps fall outside the time in view, or weren't recorded, the bar says so.

## Next steps

- [Tracing messages across services](../guides/brokers.md): setting up Kafka and RabbitMQ.
- [Navigating the graph](navigating.md)
