# Roadmap

What Ida doesn't do yet. The items aren't in priority order. If you'd like to work on one, see [Contributing](README.md#contributing).

## Planned

**Recording more kinds of events**

- Popular event libraries: mitt and eventemitter3
- Framework events: Vue's `emit` and React
- More languages, following the shared rules in [`spec/`](spec/README.md)

**Following events in the browser**

- Linking an event to its cause after an `await` or a timer. Node and Python do this already. Browsers have no built-in way yet, and Ida will use one when browsers add it (the AsyncContext proposal).

**Other ways to open the viewer**

- A viewer that opens on top of your own page, without leaving it
- A browser DevTools panel

**Running the server at scale**

- Running several servers side by side. Today, live views only work when there is a single server. (The planned approach is Postgres `LISTEN/NOTIFY`.)
- Limits on how long recorded data is kept
- A log of who changed whose access, and when

## Ideas

Things we'd like to try, not yet planned:

- **AI help with errors:** point out the likely root cause of an error faster.
- **Action nodes:** place your own nodes in the graph that react to what happens on the nodes they connect to. The first example would text chosen people in your organization when a process or handler fails. Other notification channels and actions could work the same way.
