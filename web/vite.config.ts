import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // 与 nginx 的 proxy_read_timeout 对齐，长查询不被代理层提前切断
        timeout: 300_000,
      },
    },
  },
  // 构建后本地 preview（vite preview）同样代理 /api，避免 API 全 404 踩坑
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        timeout: 300_000,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
