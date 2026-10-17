import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', core: 'src/core.ts', visuals: 'src/visuals.ts', studio: 'src/studio.ts', connectors: 'src/connectors.ts', worker: 'src/worker.ts', files: 'src/files.ts', elements: 'src/elements.ts', ai: 'src/ai.ts', react: 'src/react/index.tsx' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2020',
  external: ['react', 'react-dom', '@prismbi/prismbi', '@prismbi/prismbi/studio'],
});
