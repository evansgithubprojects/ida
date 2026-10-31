import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The demo imports the built packages, like an npm user. Settings come from apps/demo/.env.
export default defineConfig({
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  server: { port: 5174 },
});
