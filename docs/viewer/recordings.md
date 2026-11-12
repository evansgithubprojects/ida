# Opening the viewer

The viewer shows a project's events: every service live, one past run of a service, a file you exported, or a local bridge. This page covers how to get to each.

## The project view

Open your organization, then a project, and click **Open viewer**. The viewer opens **live** on every service in the project at once, linked through Kafka and RabbitMQ. It starts with the last 5 minutes and follows new events as they arrive. To look further back, open a [past run](#past-runs).

- The count at the top right says how many services have events in view.
- Clicking a recorder's key under **Recorders** on the project page opens the viewer zoomed into that service.

The URL follows what you're looking at (`?service=payments&emitter=…`), so you can share a link that opens at the same place, and **Back** steps out of a zoom.

### Switching service

The menu in the graph's top-left corner shows what's in view: **All services**, or the service you've zoomed into. Open it to see every recorder in the project, with the emitters each recorded and a dot on those that are live, and pick one to zoom into it. **All services** zooms back out.

## Past runs

Each run of your app (each process start) is one **recording** of each of its recorders. To open an earlier one:

1. Zoom into a service (from the corner menu, or by double-clicking its card).
2. Click **Recordings**.
3. Click a run's start time, or **View**.

| Column | |
| --- | --- |
| Started | When that run started. |
| Events | How many events it recorded. |
| Runtime | The Node version, browser or Python version it ran on. |
| Last data | When it last uploaded. |

A **live** dot marks a run that is still uploading. A **gaps** badge means some events were dropped because the app's offline spool was full (see [Offline and delivery](../concepts/offline.md)).

A run opens in replay mode, together with what the other services did during it, so messages it sent and received are still linked. The header says **Run of** the service. Click **Exit** at the end of the timeline's controls to return to the live view.

If a run holds more events than one view shows, only the newest are loaded and a banner says so.

## From a file

Exports from `recorder.export()` (see [Exporting recordings](../guides/export-and-format.md)) open from the same **Recordings** dialog, at any zoom: under **Open a local recording**, click **Open file…**, or drop the `.json` file anywhere on the viewer. The file is read in your browser and isn't uploaded. The header shows **Local file** and its name; **Exit** goes back to the project.

If the file isn't JSON, or isn't an Ida recording, the dialog says so.

## From a local bridge

A Node process running [`startBridge`](../quickstart/live.md#local-bridge) streams its recorder straight to your browser:

1. Open the menu in the graph's top-left corner.
2. Under **View Remote Endpoint**, enter the bridge's address, such as `http://127.0.0.1:7777`.
3. Click **Connect**.

The header shows **Endpoint** and its address. Choose **Disconnect** in the same menu, or pick a service, to return to the project.

## Banners

The viewer explains anything unusual about what it shows in a banner under the header:

| Banner | Means |
| --- | --- |
| *N events were lost while an app was offline and its spool was full* | Some events never arrived; the lost stretches are marked on the timeline. |
| *N consumed messages name publishers Ida has no record of* | A service consumed messages from a service that doesn't record with Ida (or recorded outside the time in view). |

## Waiting for events

A live view with nothing in it yet says **Waiting for events…** once connected: nothing was uploaded in the last 5 minutes. Check that your app is running and uploading with a key from this project (its console says so if it can't reach the server). If the stream drops, the viewer retries on its own; after several failures, use **Reconnect** at the top.

## Next steps

- [Replaying a recording](replay.md)
- [Navigating the graph](navigating.md)
