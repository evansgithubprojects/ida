/**
 * The docs sidebar, in reading order. Each slug is a markdown file under the repo's `docs/` folder
 * (`concepts/recorders` → `docs/concepts/recorders.md`). `integrations: true` lists the integration
 * setup pages, which come from `SOURCES` in SetupSnippet so their snippets stay in one place.
 */
export interface NavSection {
  title: string;
  pages?: readonly string[];
  integrations?: true;
}

export const NAV: readonly NavSection[] = [
  { title: 'Getting started', pages: ['overview', 'quickstart/node', 'quickstart/browser', 'quickstart/python', 'quickstart/live', 'projects'] },
  { title: 'Concepts', pages: ['concepts/events-and-causality', 'concepts/recorders', 'concepts/templates', 'concepts/offline'] },
  { title: 'Integrations', integrations: true },
  {
    title: 'Guides',
    pages: ['guides/naming', 'guides/what-gets-recorded', 'guides/brokers', 'guides/corruption', 'guides/export-and-format'],
  },
  { title: 'Using the viewer', pages: ['viewer/recordings', 'viewer/replay', 'viewer/navigating', 'viewer/traces-and-system'] },
  {
    title: 'API reference',
    pages: [
      'reference/core',
      'reference/adapter-eventemitter',
      'reference/adapter-eventtarget',
      'reference/adapter-kafkajs',
      'reference/adapter-amqplib',
      'reference/cloud',
      'reference/python',
      'reference/recording-format',
    ],
  },
  { title: 'Help', pages: ['troubleshooting'] },
];

/** The page `/docs` opens on. */
export const HOME_SLUG = 'overview';
