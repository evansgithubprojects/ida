// `npm run dev`: one tsup process watches every published package, instead of one `tsup --watch` per package.
// Type declarations are what cost memory (each DTS build keeps a TypeScript program alive, ~300 MB per package), so
// the watcher builds JavaScript only (~200 MB in all), and after a package changes it runs a one-off DTS build for that
// package in a child process that exits when done. `npm run build:packages` (run before `dev` starts) builds the
// declarations the first time. `npm run build` keeps using each package's own tsup.config.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const packages: Record<string, string[]> = {
  core: ['index.ts', 'bridge-node.ts'],
  'adapter-eventemitter': ['index.ts', 'auto.ts'],
  'adapter-eventtarget': ['index.ts'],
  'adapter-kafkajs': ['index.ts'],
  'adapter-amqplib': ['index.ts'],
  cloud: ['node.ts', 'browser.ts'],
};

const KINDS = {
  js: { ext: ['.js', '.cjs'], ref: (file: string) => file },
  // A declaration file imports its siblings by their JavaScript names: './x.js' is x.d.ts, './x.cjs' is x.d.cts.
  dts: { ext: ['.d.ts', '.d.cts'], ref: (file: string) => file.replace(/\.js$/, '.d.ts').replace(/\.cjs$/, '.d.cts') },
};

/**
 * Deletes the outputs of one kind that nothing uses any more. Shared chunks are named by content hash, so every
 * rebuild that changes one leaves the old file behind (the watcher can't `clean`: dist/ also holds the other kind).
 * Starts from the entry files, follows their relative imports, and removes the files of that kind it didn't reach.
 */
function prune(dist: string, entries: string[], kind: keyof typeof KINDS) {
  const { ext, ref } = KINDS[kind];
  const isKind = (f: string) => ext.some((e) => f.endsWith(e)) && !(kind === 'js' && /\.d\.c?ts$/.test(f));
  if (!existsSync(dist)) return;
  const files = readdirSync(dist).filter(isKind);
  const reached = new Set(entries.flatMap((e) => ext.map((x) => e.replace(/\.ts$/, x))).filter((f) => files.includes(f)));
  for (const queue = [...reached]; queue.length;) {
    const source = readFileSync(`${dist}/${queue.pop()}`, 'utf8');
    for (const [, target] of source.matchAll(/["']\.\/([^"'/]+)["']/g)) {
      const file = ref(target!);
      if (files.includes(file) && !reached.has(file)) { reached.add(file); queue.push(file); }
    }
  }
  // Nothing reached means the entries aren't there (yet): delete nothing rather than everything.
  if (!reached.size) return;
  for (const f of files) if (!reached.has(f)) { rmSync(`${dist}/${f}`); rmSync(`${dist}/${f}.map`, { force: true }); }
}

/** Rebuilds one package's declarations, at most one build at a time per package (a change during a build queues one more). */
function declarations(name: string, entries: string[]) {
  let running: ChildProcess | null = null;
  let again = false;
  const run = () => {
    running = spawn(process.execPath, [
      'node_modules/tsup/dist/cli-default.js', '--no-config', '--dts-only', '--format', 'esm,cjs',
      '--out-dir', `packages/${name}/dist`, '--tsconfig', `packages/${name}/tsconfig.json`,
      ...entries.map((e) => `packages/${name}/src/${e}`),
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    running.on('exit', (code) => {
      running = null;
      if (code) console.error(`[${name}] declarations failed (exit ${code})`);
      else prune(`packages/${name}/dist`, entries, 'dts');
      if (again) { again = false; run(); }
    });
  };
  return () => { if (running) again = true; else run(); };
}

export default defineConfig(Object.entries(packages).map(([name, entries]): Options => {
  const dir = `packages/${name}`;
  const dts = declarations(name, entries);
  let first = true;
  return {
    name,
    entry: entries.map((e) => `${dir}/src/${e}`),
    outDir: `${dir}/dist`,
    tsconfig: `${dir}/tsconfig.json`,
    format: ['esm', 'cjs'],
    // No `clean`: the declarations from `build:packages` stay in dist/. `prune` removes stale files instead.
    // Rebuild a package only when its own sources change (the default watches the whole repo).
    watch: [`${dir}/src`],
    async onSuccess() {
      prune(`${dir}/dist`, entries, 'js');
      // The first build only repeats what `build:packages` just did, declarations included.
      if (first) { first = false; return; }
      dts();
    },
  };
}));
