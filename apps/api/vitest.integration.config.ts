import { defineConfig } from 'vitest/config';

// كل ملف اختبار ينشئ قاعدة مؤقتة خاصة به. لكن الملفات تعمل بالتتابع لأن دور inventory_app
// مشترك على مستوى الخادم، وتهجير عدة قواعد معاً يلمس كتالوجات مشتركة (انظر التهجيرة الأولى).
// Each test file creates its own temporary database. Files still run one after another because
// the inventory_app role is cluster-wide and migrating several databases at once touches shared
// catalogs (see the first migration). The suite is fast, so determinism costs almost nothing.
export default defineConfig({
  test: {
    include: ['**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
