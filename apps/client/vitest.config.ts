import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    server: {
      deps: {
        // vim-prosemirror@0.2.0 publishes ESM with extensionless relative
        // imports ("./state" instead of "./state.js"), which Node's ESM
        // resolver rejects. Vite's bundling backfills the extension, so run it
        // through the transform pipeline instead of externalising it.
        inline: ['vim-prosemirror'],
      },
    },
  },
});
