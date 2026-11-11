// `npm run dev` for the demo: starts Kafka and RabbitMQ (compose.yaml), then runs the shop with its broker leg on.
// Without Docker, or with DEMO_BROKERS=0, the shop runs on its own. The brokers stop when you stop the dev server.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch { /* no .env */ }
const off = ['0', 'false'].includes(process.env.DEMO_BROKERS ?? '');

let brokers = false;
if (!off) {
  console.log('[demo] starting Kafka and RabbitMQ (docker compose)...');
  const up = spawnSync('docker', ['compose', 'up', '-d', '--wait'], { stdio: 'inherit' });
  brokers = up.status === 0;
  if (!brokers) console.warn('[demo] could not start the brokers (is Docker running?). Running the shop without its broker leg.');
}

// tsx's CLI run by this Node directly: going through `npx` adds an npm process (~90 MB) for the whole session.
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));
const demo = spawn(process.execPath, [tsx, 'watch', 'src/node.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, DEMO_BROKERS: brokers ? '1' : '0' },
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  demo.kill('SIGTERM');
  // `stop`, not `down`: the containers stay, so the next start is quick. `npm run brokers:down` removes them.
  if (brokers) spawnSync('docker', ['compose', 'stop'], { stdio: 'inherit' });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
demo.on('exit', (code) => { if (!stopping) { stopping = true; if (brokers) spawnSync('docker', ['compose', 'stop'], { stdio: 'inherit' }); process.exit(code ?? 0); } });
