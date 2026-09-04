import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Component and unit tests.
 *
 * Vitest rather than Jest: it reuses Vite's transform pipeline, so TSX and the
 * `@/*` alias work with no extra transformer, and a watch run starts in about a
 * second. The API keeps Jest — it is already configured there and swapping a
 * working test suite buys nothing.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
    css: false,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
