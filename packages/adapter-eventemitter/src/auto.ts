/**
 * Side-effect import: `import '@ida/adapter-eventemitter/auto'` starts recording on the shared recorder
 * (see `enable()` in `@ida/core`) with default options. Emitters claimed with `recorder.track()` go to their
 * own recorders instead. Use `enableEventEmitterRecording` to configure it.
 */
import { enable } from '@ida/core';
import { enableEventEmitterRecording } from './index';

enable();
enableEventEmitterRecording();
