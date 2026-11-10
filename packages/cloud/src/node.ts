import { fileStore } from './store-node';
import { createUploader, type CloudOptions, type Uploader } from './uploader';

export { fileStore } from './store-node';
export { indexedDbStore } from './store-browser';
export { memoryStore, type SpoolStore } from './spool';
export type { CloudOptions, Uploader, UploadStatus } from './uploader';

let current: Uploader | undefined;

/**
 * Uploads every recorder made with `connectRecorder()` (or `enable()`) to your project, from now on and including
 * what they already hold. Call it once at startup. While the server can't be reached, batches are kept in
 * `.ida/spool` and uploaded, in order, when it is back; the console says when that happens.
 * @example
 * configure({ projectKey: process.env.IDA_PROJECT_KEY!, endpoint: 'https://api.example.com' });
 */
export function configure(opts: CloudOptions): Uploader {
  if (current) throw new Error('[ida] configure() was already called; close() the uploader it returned first');
  const uploader = createUploader(opts, () => fileStore(), `node ${process.versions.node}`);
  current = uploader;
  // Last batches before the process exits; best effort.
  const onExit = () => { void uploader.flush(); };
  process.once('beforeExit', onExit);
  const close = uploader.close;
  return Object.assign(uploader, {
    async close() {
      process.off('beforeExit', onExit);
      await close();
      current = undefined;
    },
  });
}
