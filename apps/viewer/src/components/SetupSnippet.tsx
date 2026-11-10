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
IDA_PROJECT_KEY=${key}

npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventemitter

import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '${API_URL}' });
enable(); // records every emitter nothing else claims
enableEventEmitterRecording();

// anywhere in your app
connectRecorder('payments').track(paymentsBus);`
    : `npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventtarget

import { configure } from '@ida-dev/cloud';
import { connectRecorder } from '@ida-dev/core';
import { enableEventTargetRecording } from '@ida-dev/adapter-eventtarget';

configure({ projectKey: '${key}', endpoint: '${API_URL}' });

const recorder = connectRecorder('page');
enableEventTargetRecording(recorder);`;
  return <pre className="snippet">{code}</pre>;
}
