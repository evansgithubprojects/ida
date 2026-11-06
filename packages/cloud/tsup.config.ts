import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/node.ts', 'src/browser.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});
