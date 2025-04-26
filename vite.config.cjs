import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

module.exports = defineConfig({
  plugins: [
    react(),
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    port: 5173,
  },
}); 