import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ida/core': src('./packages/core/src/index.ts'),
      '@ida/adapter-eventemitter': src('./packages/adapter-eventemitter/src/index.ts'),
      '@ida/adapter-eventtarget': src('./packages/adapter-eventtarget/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environmentMatchGlobs: [['packages/adapter-eventtarget/**', 'jsdom']],
  },
});
