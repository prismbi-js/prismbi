import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  resolve: {
    alias: [
      { find: /^prismbi$/, replacement: src('index.ts') },
      { find: /^prismbi\/core$/, replacement: src('core.ts') },
      { find: /^prismbi\/visuals$/, replacement: src('visuals.ts') },
      { find: /^prismbi\/studio$/, replacement: src('studio.ts') },
      { find: /^prismbi\/connectors$/, replacement: src('connectors.ts') },
      { find: /^prismbi\/worker$/, replacement: src('worker.ts') },
      { find: /^prismbi\/files$/, replacement: src('files.ts') },
    ],
  },
  build: { rollupOptions: { input: { main: here('./index.html'), studio: here('./studio.html'), perf: here('./perf.html') } } },
  server: { port: 5173, open: false },
});
