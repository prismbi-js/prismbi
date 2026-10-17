import { readdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

// per-visual entries: @prismbi/prismbi/visuals/<name>
const visualEntries = Object.fromEntries(readdirSync('src/visuals/entries').filter((f) => f.endsWith('.ts')).map((f) => [`visuals/${f.slice(0, -3)}`, `src/visuals/entries/${f}`]));

export default defineConfig({
  entry: { index: 'src/index.ts', core: 'src/core.ts', visuals: 'src/visuals.ts', studio: 'src/studio.ts', connectors: 'src/connectors.ts', worker: 'src/worker.ts', files: 'src/files.ts', elements: 'src/elements.ts', ai: 'src/ai.ts', server: 'src/server.ts', collab: 'src/collab.ts', plugins: 'src/plugins.ts', powerbi: 'src/powerbi.ts', sql: 'src/sql.ts', react: 'src/react/index.tsx', ...visualEntries },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2020',
  external: ['react', 'react-dom', '@prismbi/prismbi', '@prismbi/prismbi/studio'],
});
