import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^prismbi$/, replacement: src('index.ts') },
      { find: /^prismbi\/core$/, replacement: src('core.ts') },
      { find: /^prismbi\/visuals$/, replacement: src('visuals.ts') },
      { find: /^prismbi\/studio$/, replacement: src('studio.ts') },
    ],
  },
  test: { environment: 'jsdom', globals: true, include: ['tests/**/*.test.ts'] },
});
