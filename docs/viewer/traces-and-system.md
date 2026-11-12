# Services and traces

When your app is several services talking through Kafka or RabbitMQ, the viewer shows them together and lets you follow one message through all of them. This page covers the services level and traces.

## Services

The live project view opens on every service at once:

- Each **service** card is one recorder key (`checkout`, `payments`, `notifier`). Several runs of it in the time shown (restarts, or several instances) are one card.
- **Topics**, **exchanges** and **queues** sit between the services that use them, shared by every service that produces to or consumes from them. Each carries its broker's logo and its kind (Kafka topic, RabbitMQ exchange or queue); hover the badge to read it.
- **Dotted pathways** carry messages from one service to another, linked by the `ida-parent` header (see [Tracing messages across services](../guides/brokers.md)).

Double-click a service to zoom into its processes, and a process to zoom into its handlers. Inside a service, the processes it exchanges events with elsewhere appear as small cards at the edge, marked with the service they're *in* (or *other process*), so you can still see where its messages come from and go.

Select a service's card to see its **Runs** in view, and the **Runtime** and SDK version each ran on.

### Clocks

Each service timestamps its own events. The server estimates each service's clock offset when it uploads and puts all services on one clock, so messages play back in order. If a message still appears consumed before it was published, the server moves the consuming service's events later by the smallest amount that fixes it (the order within the service doesn't change). The correction is stored with the service's run, so it is the same in every time window and in the live view. Two services that message each other in both directions can't always both be fixed; a service is only moved as far as the messages it sends back allow.

### Missing publishers

A message whose header names a publish Ida has no record of (the sender doesn't record with Ida, or its events are outside the time in view) is still shown, and a banner counts how many there are.

## Traces

A **trace** is a slideshow of what caused something: the path of events from the root to it, across services and brokers, one step at a time.

Clicking a **notification** (an error or a suspected corrupt payload) opens its trace. So does any link to an error, or selecting an event and pressing **T** (or **Trace what led here** in the inspector).

- An **error**'s trace runs from the root event to the handler that threw.
- A **suspected corrupt payload**'s trace runs through the error it's traced to, then on to the payload itself. Events emitted after the failure on the way are marked as possibly carrying the bad state.
- An **event**'s trace runs from the root to that event.

The trace replaces the timeline at the bottom of the screen. It opens on the first step (where the chain started) and ends on the error, payload or event. Each step shows:

- a **subtitle** saying why the step matters: where the chain started, which handler emitted the next event, the broker a message went through and how long it waited there, which handler threw and with what message;
- the graph zoomed into the handlers of the process the step happens in (the throwing handler's on an error step), whatever level you were at;
- the step's pathway pulsing on the graph. Steps already shown stay lit, steps still ahead are faint, and everything else fades;
- the step in the inspector.

Below the subtitle, a strip lists every step, oldest first, with each step's service (shown when it changes), broker, event and handler. Errors are marked with a red ✕ and the corrupt payload with ⚠. Click a step to jump to it.

Step with **‹ Prev** / **Next ›** or **←** / **→**. **▶ Play** steps forward on its own (**Space**). Press **Esc** or click **✕** to end the trace.

While a trace is open the graph shows no other traffic, and a live view stops updating. New events wait and are added when the trace ends, and the view goes back to following the stream.

If the path's start falls outside the time in view, or wasn't recorded, the first step says so.

## Next steps

- [Tracing messages across services](../guides/brokers.md): setting up Kafka and RabbitMQ.
- [Navigating the graph](navigating.md)
