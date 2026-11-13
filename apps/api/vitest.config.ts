import { configDefaults, defineConfig } from 'vitest/config';

// اختبارات الوحدة فقط؛ اختبارات التكامل (*.int.test.ts) تحتاج PostgreSQL ولها إعداد منفصل.
// Unit tests only; integration tests (*.int.test.ts) need PostgreSQL and have their own config.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/*.int.test.ts'] },
});
