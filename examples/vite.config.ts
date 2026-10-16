import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { prismbi: fileURLToPath(new URL('../src/index.ts', import.meta.url)) } },
  server: { port: 5173, open: false },
});
