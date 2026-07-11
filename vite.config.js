import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  optimizeDeps: {
    // transformers.js ships its own WASM/worker assets; pre-bundling breaks its
    // internal URL resolution (same class of issue as pdfjs workers).
    exclude: ['@huggingface/transformers'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
