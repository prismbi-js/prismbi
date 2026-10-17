import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@prismbi\/prismbi$/, replacement: src('index.ts') },
      { find: /^@prismbi\/prismbi\/core$/, replacement: src('core.ts') },
      { find: /^@prismbi\/prismbi\/visuals$/, replacement: src('visuals.ts') },
      { find: /^@prismbi\/prismbi\/visuals\/([\w-]+)$/, replacement: src('visuals/entries/$1.ts') },
      { find: /^@prismbi\/prismbi\/studio$/, replacement: src('studio.ts') },
      { find: /^@prismbi\/prismbi\/connectors$/, replacement: src('connectors.ts') },
      { find: /^@prismbi\/prismbi\/worker$/, replacement: src('worker.ts') },
      { find: /^@prismbi\/prismbi\/files$/, replacement: src('files.ts') },
      { find: /^@prismbi\/prismbi\/elements$/, replacement: src('elements.ts') },
      { find: /^@prismbi\/prismbi\/ai$/, replacement: src('ai.ts') },
      { find: /^@prismbi\/prismbi\/server$/, replacement: src('server.ts') },
      { find: /^@prismbi\/prismbi\/collab$/, replacement: src('collab.ts') },
      { find: /^@prismbi\/prismbi\/sql$/, replacement: src('sql.ts') },
      { find: /^@prismbi\/prismbi\/plugins$/, replacement: src('plugins.ts') },
      { find: /^@prismbi\/prismbi\/powerbi$/, replacement: src('powerbi.ts') },
    ],
  },
  test: { environment: 'jsdom', globals: true, include: ['tests/**/*.test.ts'] },
});
