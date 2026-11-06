/**
 * Side-effect import: `import '@eda-debugger/adapter-eventemitter/auto'` starts recording on the shared recorder
 * (see `enable()` in `@eda-debugger/core`) with default options. Emitters claimed with `recorder.track()` go to their
 * own recorders instead. Use `enableEventEmitterRecording` to configure it.
 */
import { enable } from '@eda-debugger/core';
import { enableEventEmitterRecording } from './index';

enable();
enableEventEmitterRecording();
