// Lint is only for React hooks bugs. Prettier owns style; tsc owns types.
import Module, { createRequire } from 'node:module';

// typescript-eslint needs the TypeScript JS API, which the native TypeScript 7 package
// (used by `tsc`) does not have. Point its `require('typescript')` at the TS 6 package instead.
const require = createRequire(import.meta.url);
const ts6 = require.resolve('@typescript/typescript6');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'typescript' ? ts6 : resolveFilename.call(this, request, ...rest);
};

const { default: tseslint } = await import('typescript-eslint');
const { default: reactHooks } = await import('eslint-plugin-react-hooks');

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
      '**/*.{js,mjs,cjs}',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'server/**/*.{ts,tsx}', 'server.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
