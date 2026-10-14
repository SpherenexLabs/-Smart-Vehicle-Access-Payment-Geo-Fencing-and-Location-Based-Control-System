import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  esbuild: { jsx: 'automatic' },
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: false }
});
