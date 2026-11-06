import { createServer, type Server } from 'node:http';
import type { Recorder } from './recorder';

/** Options for `startBridge`. */
export interface BridgeOptions {
  /**
   * Port to listen on. Use 0 to pick a free one.
   * @default 7777
   */
  port?: number;
  /**
   * Interface to listen on. Keep it on loopback: the stream carries your event data.
   * @default '127.0.0.1'
   */
  host?: string;
}

/** A running bridge. */
export interface Bridge {
  /** The port actually listening, which matters when `port: 0` was requested. */
  port: number;
  /** Stop streaming and close every viewer connection. */
  close(): Promise<void>;
}

/**
 * Streams a recorder to viewers over Server-Sent Events: a snapshot on connect, then every new
 * occurrence and finding. (SSE needs no dependency and the browser reconnects by itself.)
 * @example
 * const bridge = await startBridge(recorder);
 * // in the viewer, open the recorder dropdown and choose "View Remote Endpoint"; later: await bridge.close();
 */
export function startBridge(recorder: Recorder, opts: BridgeOptions = {}): Promise<Bridge> {
  const clients = new Set<import('node:http').ServerResponse>();
  const send = (res: import('node:http').ServerResponse, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const unsubscribe = recorder.subscribe((m) => clients.forEach((c) => send(c, m)));
  const server: Server = createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    clients.add(res);
    send(res, { type: 'snapshot', recording: recorder.export() });
    req.on('close', () => clients.delete(res));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7777, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : (opts.port ?? 7777),
        close: () => new Promise<void>((done) => {
          unsubscribe();
          clients.forEach((c) => c.end());
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
