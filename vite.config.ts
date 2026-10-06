import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
      '/health': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
})
