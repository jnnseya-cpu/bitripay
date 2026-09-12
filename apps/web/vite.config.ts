import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true },
      '/v1': { target: process.env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true },
      // Server-rendered marketing pages, feeds and crawler files live on the API.
      ...Object.fromEntries(['/lite', '/blog', '/legal', '/about', '/contact', '/sitemap.xml', '/feed.xml', '/robots.txt', '/llms.txt', '/llms-full.txt'].map((p) => [p, { target: process.env.VITE_API_PROXY || 'http://localhost:4000', changeOrigin: true }])),
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
