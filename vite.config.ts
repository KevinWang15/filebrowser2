import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// Keep the browser's Host header so the backend's same-origin check accepts proxied requests.
const target = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000'
const proxy = { target, changeOrigin: false }

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    proxy: {
      '/api': proxy,
      '/health': proxy,
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
})
