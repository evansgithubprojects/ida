/**
 * Side-effect import: `import '@ida-dev/adapter-eventemitter/auto'` starts recording on the shared recorder
 * (see `enable()` in `@ida-dev/core`) with default options. Emitters claimed with `recorder.track()` go to their
 * own recorders instead. Use `enableEventEmitterRecording` to configure it.
 */
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from './index';

enable();
enableEventEmitterRecording();
