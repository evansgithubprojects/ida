# Replaying a recording

The bottom of the viewer is the timeline. It switches between following events live and replaying what was recorded, and lets you play, pause and scrub.

Replay never runs your code. It plays the recorded events back against the graph, so it's safe to replay anything, any number of times.

## Live and Replay

A live recording has two modes, chosen at the bottom left:

- **● Live** follows the stream. The graph shows the newest events as they arrive, and the readout says how many are shown and whether the stream is `live`, connecting, or in error.
- **Replay** stops following and opens the timeline, so you can go back over what has arrived. New events keep arriving in the background.

Selecting an event anywhere (in the inspector, a trace, a notification) switches to Replay and moves the playhead to it. Click **● Live** to follow the stream again.

Past runs and files only have Replay.

## The timeline

The track shows the whole recording:

| On the track | Means |
| --- | --- |
| Bars | How many events happened at that moment. |
| Shaded band | The **replay window**: the stretch of time the graph and lists show. |
| Vertical line | The **playhead**: the current moment. |
| Red ticks along the bottom | A handler threw. |
| Yellow ticks | A [suspected corrupt payload](../guides/corruption.md). |
| Thicker orange ticks | A suspected corrupt payload reaching an external system. |
| Dashed ticks along the top | Events uploaded late, from an app's offline spool. |
| Faint yellow stretch | A gap: events lost because an app's offline spool was full. |
| Accent ticks | Steps of the message you're [tracing](traces-and-system.md). |

Hover a tick or stretch to see what it is.

### Playing and scrubbing

- **▶ Play** / **❚❚ Pause**, or press **Space**.
- **Speed** sets the playback rate, from 0.01× to 4×. Slow speeds let you watch bursts that happen within a few milliseconds.
- **Click or drag** on the track to move the playhead.
- The readout shows the playhead's time from the start of the recording, and the recording's length.

As the playhead passes an event, a pulse travels along its pathway in the graph, from the sender to the receiver. Pulses carrying a suspected corrupt payload are yellow. To see only those, open the graph settings (the cog in the graph's top-right corner) and turn on **Quiet healthy pulses**.

### Zooming the track

- **Scroll** over the track to zoom in around the pointer, down to 20 ms.
- **Shift-scroll** (or scroll sideways) to pan.
- **Reset zoom** shows the whole recording again.

## The replay window

The graph and the inspector's lists show the events inside the replay window, the shaded band, not the whole recording. The window holds at most 500 events, so the graph stays readable however long the recording is. The readout next to the speed shows the window's start and end times and how many events it holds.

The window follows the playhead: it stays put while the playhead is inside it, and moves to trail the playhead once it leaves. To look at a different stretch of time, move the playhead there, or select an event from that time.

In the live project view, the menu at the top right also picks how much history the view starts with, from the last 5 minutes to the last 24 hours.

## Keyboard

| Key | Does |
| --- | --- |
| Space | Play or pause (in Replay). |
| I | Show or hide the inspector. |
| T | Trace the selected event. |
| Esc | End the trace. |
| ← / → | Move the playhead in a handler's activity track, when it has focus. |

## Next steps

- [Navigating the graph](navigating.md): zoom levels and the inspector.
- [Services and traces](traces-and-system.md)
