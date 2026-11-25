import { defineConfig } from 'vitest/config';

// الاختبارات للمنطق الخالص فقط (بلا React Native)؛ الشاشات تُجرَّب على جهاز حقيقي.
// Tests cover pure logic only (no React Native); screens are tried on a real device.
export const config = defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
export default config;
