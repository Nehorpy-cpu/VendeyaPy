/**
 * ESLint raíz — paquetes TypeScript del monorepo (apps/functions, packages/shared).
 * apps/web tiene su propia config (next/core-web-vitals, root:true) y NO hereda de ésta.
 *
 * Objetivo Fase 1 (pipeline): que `pnpm lint` sea ÚTIL y a la vez VERDE.
 * Los hallazgos de estilo pre-existentes se reportan como WARNINGS (no rompen CI);
 * se irán limpiando en fases posteriores. Sólo bloquean (error) los problemas reales.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: [
    'node_modules/',
    '**/lib/**',
    '**/dist/**',
    '**/.next/**',
    'apps/web/**',
    '**/*.mjs',
    '**/*.cjs',
    '**/*.config.ts',
  ],
  rules: {
    // TypeScript ya cubre estos:
    'no-undef': 'off',
    'no-redeclare': 'off',
    'no-dupe-class-members': 'off',
    // Ruido de estilo pre-existente → warning (no bloquea CI day-1):
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-inferrable-types': 'off',
    '@typescript-eslint/no-empty-object-type': 'off',
    '@typescript-eslint/no-unsafe-function-type': 'warn',
    '@typescript-eslint/no-this-alias': 'warn',
    '@typescript-eslint/no-require-imports': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-case-declarations': 'warn',
    'no-fallthrough': 'warn',
    'no-useless-escape': 'warn',
    'no-constant-condition': ['warn', { checkLoops: false }],
    'prefer-const': 'warn',
  },
};
