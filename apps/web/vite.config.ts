import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// التطوير: الواجهة على 5173 وتمرّر /api إلى الخادم المحلي، فتبقى كوكي التحديث لنفس الأصل كما في الإنتاج.
// Dev: the UI runs on 5173 and proxies /api to the local server, so the refresh cookie stays same-origin as in production.
export const config = defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { sourcemap: false },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
export default config;
