import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Usar el runtime JSX automático (como Next.js) para poder testear componentes .tsx sin
  // importar React en cada archivo. Solo afecta a los tests; el build real usa Next.
  esbuild: { jsx: 'automatic' },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
