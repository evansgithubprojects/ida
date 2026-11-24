import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SpoolStore } from './spool';

/** Keeps spooled batches as files in `dir`, so they survive a restart. */
export function fileStore(dir = '.ida/spool'): SpoolStore {
  const root = resolve(dir);
  const file = (id: number) => join(root, `${String(id).padStart(12, '0')}.json`);
  let made: Promise<unknown> | null = null;
  const ensure = () => (made ??= mkdir(root, { recursive: true }));
  return {
    where: root,
    async list() {
      await ensure();
      const names = (await readdir(root)).filter((n) => /^\d{12}\.json$/.test(n)).sort();
      return Promise.all(names.map(async (n) => ({ id: Number(n.slice(0, 12)), bytes: (await stat(join(root, n))).size })));
    },
    async write(id, data) {
      await ensure();
      await writeFile(file(id), data);
    },
    read: (id) => readFile(file(id), 'utf8').catch(() => undefined),
    remove: (id) => rm(file(id), { force: true }),
  };
}
