import { API_URL } from '../cloud/supabase';

/** Install and configure steps for an app that uploads to a project. */
export function SetupSnippet() {
  return (
    <pre className="snippet">{`npm install @eda-debugger/core @eda-debugger/cloud @eda-debugger/adapter-eventemitter

import { configure } from '@eda-debugger/cloud';
import { connectRecorder } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';

configure({ projectKey: process.env.EDA_PROJECT_KEY, endpoint: '${API_URL}' });
enableEventEmitterRecording();

// anywhere in your app
connectRecorder('payments').track(paymentsBus);`}</pre>
  );
}
