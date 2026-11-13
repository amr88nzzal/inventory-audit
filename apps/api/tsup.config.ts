import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // نضمّن الحزمة المشتركة (مصدر TypeScript) ونترك بقية الاعتماديات خارجية.
  // Bundle the shared package (TypeScript source); keep other dependencies external.
  noExternal: ['@inventory/shared'],
});
