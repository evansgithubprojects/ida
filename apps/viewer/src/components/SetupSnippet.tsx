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

npm install @ida/core @ida/cloud @ida/adapter-eventemitter

import { configure } from '@ida/cloud';
import { connectRecorder } from '@ida/core';
import { enableEventEmitterRecording } from '@ida/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '${API_URL}' });
enableEventEmitterRecording();

// anywhere in your app
connectRecorder('payments').track(paymentsBus);`
    : `npm install @ida/core @ida/cloud @ida/adapter-eventtarget

import { configure } from '@ida/cloud';
import { connectRecorder } from '@ida/core';
import { enableEventTargetRecording } from '@ida/adapter-eventtarget';

configure({ projectKey: '${key}', endpoint: '${API_URL}' });

const recorder = connectRecorder('page');
enableEventTargetRecording(recorder);`;
  return <pre className="snippet">{code}</pre>;
}
