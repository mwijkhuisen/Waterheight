import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API and the map are separate processes in dev; proxying keeps the
    // browser on one origin so no CORS handling is needed here.
    proxy: {
      '/api': {
        target: process.env['API_ORIGIN'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
