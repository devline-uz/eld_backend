// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // TZ §3.5 / task constraint: no `any` in public signatures.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Layering guard (TZ §3.5): services and controllers must never touch prisma directly.
    files: ['src/**/*.service.ts', 'src/**/*.controller.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.property.name='prisma']",
          message: 'TZ §3.5: prisma.* may only be called inside a *.repository.ts via BaseRepository.',
        },
      ],
    },
  },
  {
    // TZ §3.5 exception: hos/ is pure functions — no Nest DI, no DB.
    files: ['src/modules/hos/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@nestjs/*', '@prisma/client', '**/core/prisma/*'],
        },
      ],
    },
  },
  { files: ['**/*.spec.ts', 'test/**/*.ts'], rules: { '@typescript-eslint/unbound-method': 'off' } },
  {
    // supertest's `.body` is untyped (`any`) by design; e2e specs assert on JSON shapes
    // dynamically rather than importing every response DTO.
    files: ['test/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
