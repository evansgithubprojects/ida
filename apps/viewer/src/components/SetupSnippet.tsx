import { API_URL } from '../cloud/supabase';

export const LANGUAGES = [
  { id: 'node', label: 'Node.js' },
  { id: 'browser', label: 'JavaScript (browser)' },
] as const;
export type Language = (typeof LANGUAGES)[number]['id'];

/** Install and configure steps for an app that uploads to a project, in the chosen language. `projectKey` is filled in when it is known. */
export function SetupSnippet({ language, projectKey }: { language: Language; projectKey?: string | null }) {
  const key = projectKey ?? 'ida_…';
  const code = language === 'node'
    ? `# .env
EDA_PROJECT_KEY=${key}

npm install @eda-debugger/core @eda-debugger/cloud @eda-debugger/adapter-eventemitter

import { configure } from '@eda-debugger/cloud';
import { connectRecorder } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';

configure({ projectKey: process.env.EDA_PROJECT_KEY, endpoint: '${API_URL}' });
enableEventEmitterRecording();

// anywhere in your app
connectRecorder('payments').track(paymentsBus);`
    : `npm install @eda-debugger/core @eda-debugger/cloud @eda-debugger/adapter-eventtarget

import { configure } from '@eda-debugger/cloud';
import { connectRecorder } from '@eda-debugger/core';
import { enableEventTargetRecording } from '@eda-debugger/adapter-eventtarget';

configure({ projectKey: '${key}', endpoint: '${API_URL}' });

const recorder = connectRecorder('page');
enableEventTargetRecording(recorder);`;
  return <pre className="snippet">{code}</pre>;
}
