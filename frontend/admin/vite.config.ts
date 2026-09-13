import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/brand': { target: process.env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true },
      '/api': { target: process.env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true },
      '/v1': { target: process.env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
