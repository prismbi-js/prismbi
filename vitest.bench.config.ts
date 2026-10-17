import { defineConfig } from 'vitest/config';

// `npm run bench`: timing runs kept out of the regular test suite
export default defineConfig({ test: { include: ['bench/**/*.test.ts'], environment: 'node' } });
