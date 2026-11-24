import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ida-dev/core': src('./packages/core/src/index.ts'),
      '@ida-dev/adapter-eventemitter': src('./packages/adapter-eventemitter/src/index.ts'),
      '@ida-dev/adapter-eventtarget': src('./packages/adapter-eventtarget/src/index.ts'),
      '@ida-dev/adapter-kafkajs': src('./packages/adapter-kafkajs/src/index.ts'),
      '@ida-dev/adapter-amqplib': src('./packages/adapter-amqplib/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environmentMatchGlobs: [['packages/adapter-eventtarget/**', 'jsdom']],
  },
});
