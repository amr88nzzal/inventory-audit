import { defineConfig } from 'vitest/config';

// كل ملف اختبار ينشئ قاعدة مؤقتة خاصة به، فيمكن تشغيل الملفات بالتوازي بأمان.
// Each test file creates its own temporary database, so files can safely run in parallel.
export default defineConfig({
  test: {
    include: ['**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
