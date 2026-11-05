import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Auth } from './auth';
import type { createAttacks } from './attacks';

interface DashboardOptions {
  port: number;
  attacks: ReturnType<typeof createAttacks>;
  auth: Auth;
  /** Where the Ida web app is, for the link on the page. */
  idaUrl: string;
  /** Normal shop traffic so far, for the status line. */
  normal: () => { rounds: number };
}

/**
 * The attack simulator's page and its tiny API. It's a plain Node server: the Node adapter ignores Node's own servers,
 * so serving this page is not recorded as shop traffic.
 */
export function startDashboard({ port, attacks, auth, idaUrl, normal }: DashboardOptions) {
  const page = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').replace('__IDA_URL__', idaUrl);
  const json = (res: import('node:http').ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const state = () => ({ attacks: attacks.status(), security: auth.stats, normal: normal() });

  const server = createServer((req, res) => {
    const { method, url } = req;
    if (method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    } else if (method === 'GET' && url === '/status') {
      json(res, state());
    } else if (method === 'POST' && url === '/attack/brute-force') {
      void attacks.bruteForce();
      json(res, state());
    } else if (method === 'POST' && url === '/attack/overload') {
      void attacks.overload();
      json(res, state());
    } else if (method === 'POST' && url === '/attack/stop') {
      attacks.stop();
      json(res, state());
    } else {
      json(res, { error: 'not found' }, 404);
    }
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? `[demo] dashboard port ${port} is taken; set DEMO_PORT to another port` : `[demo] dashboard failed: ${e.message}`);
  });
  server.listen(port, () => console.log(`[demo] attack simulator: http://localhost:${port}`));
  return server;
}
