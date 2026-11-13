import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // دوال سهمية فقط، وبلا export default (قواعد المشروع)
      // Arrow functions only and no default exports (project conventions).
      'func-style': ['error', 'expression'],
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true } }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // معالج أخطاء Express يُعرَّف بأربعة معاملات، فنسمح بما يبدأ بـ _.
      // Express error handlers need four params, so allow underscore-prefixed ones.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // نسمح بالتصريحات (declare global) فقط لتوسعة أنواع المكتبات.
      // Allow declarations only (declare global), for augmenting library types.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
  {
    // ملفات الإعداد تتطلب export default بحكم أدواتها
    // Tool config files require a default export by design.
    files: ['**/*.config.{js,mjs,ts}'],
    rules: { 'no-restricted-exports': 'off' },
  },
);
