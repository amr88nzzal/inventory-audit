import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
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
      // حدود الوحدات: لا استيراد من ملف داخلي في وحدة أخرى، بل عبر index.ts الخاص بها فقط.
      // Module boundaries: never import an internal file of another module, only its index.ts.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/*', '!**/db/index'],
              message: 'Import the db module through its index (../db), not its internal files.',
            },
            {
              group: ['**/modules/*/*', '!**/modules/*/index'],
              message: 'Import a module through its index.ts, not its internal files.',
            },
          ],
        },
      ],
      // معالج أخطاء Express يُعرَّف بأربعة معاملات، فنسمح بما يبدأ بـ _.
      // Express error handlers need four params, so allow underscore-prefixed ones.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // نسمح بالتصريحات (declare global) فقط لتوسعة أنواع المكتبات.
      // Allow declarations only (declare global), for augmenting library types.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },
  {
    // الواجهة: قواعد الوصول (a11y) كأخطاء، وحدود الوحدات الخاصة بالخادم لا تنطبق عليها.
    // The web app: accessibility rules as errors; the server's module-boundary rules do not apply to it.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'no-restricted-imports': 'off',
    },
  },
  {
    // ملفات الإعداد تتطلب export default بحكم أدواتها
    // Tool config files require a default export by design.
    files: ['**/*.config.{js,mjs,ts}'],
    rules: { 'no-restricted-exports': 'off' },
  },
);
