import { defaultBrowserStore } from './store-browser';
import { createUploader, type CloudOptions, type Uploader } from './uploader';

export { indexedDbStore } from './store-browser';
export { memoryStore, type SpoolStore } from './spool';
export type { CloudOptions, Uploader, UploadStatus } from './uploader';

let current: Uploader | undefined;

/**
 * Uploads every recorder made with `connectRecorder()` (or `enable()`) to your project, from now on and including
 * what they already hold. Call it once at startup. While the server can't be reached, batches are kept in IndexedDB
 * and uploaded, in order, when it is back; the console says when that happens.
 * @example
 * configure({ projectKey: import.meta.env.VITE_EDA_PROJECT_KEY, endpoint: 'https://api.example.com' });
 */
export function configure(opts: CloudOptions): Uploader {
  if (current) throw new Error('[eda-debugger] configure() was already called; close() the uploader it returned first');
  const uploader = createUploader(opts, defaultBrowserStore, typeof navigator !== 'undefined' ? navigator.userAgent : 'browser');
  current = uploader;
  // A page being hidden may never come back: send what's pending while we still can.
  const onHide = () => { if (document.visibilityState === 'hidden') void uploader.flush(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHide);
  const close = uploader.close;
  return Object.assign(uploader, {
    async close() {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide);
      await close();
      current = undefined;
    },
  });
}
