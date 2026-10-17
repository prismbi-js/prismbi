import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  resolve: {
    alias: [
      { find: /^@prismbi\/prismbi$/, replacement: src('index.ts') },
      { find: /^@prismbi\/prismbi\/core$/, replacement: src('core.ts') },
      { find: /^@prismbi\/prismbi\/visuals$/, replacement: src('visuals.ts') },
      { find: /^@prismbi\/prismbi\/studio$/, replacement: src('studio.ts') },
      { find: /^@prismbi\/prismbi\/connectors$/, replacement: src('connectors.ts') },
      { find: /^@prismbi\/prismbi\/worker$/, replacement: src('worker.ts') },
      { find: /^@prismbi\/prismbi\/files$/, replacement: src('files.ts') },
      { find: /^@prismbi\/prismbi\/elements$/, replacement: src('elements.ts') },
      { find: /^@prismbi\/prismbi\/ai$/, replacement: src('ai.ts') },
      { find: /^@prismbi\/prismbi\/server$/, replacement: src('server.ts') },
      { find: /^@prismbi\/prismbi\/collab$/, replacement: src('collab.ts') },
    ],
  },
  build: { rollupOptions: { input: { main: here('./index.html'), studio: here('./studio.html'), perf: here('./perf.html'), elements: here('./elements.html') } } },
  server: { port: 5173, open: false },
});
