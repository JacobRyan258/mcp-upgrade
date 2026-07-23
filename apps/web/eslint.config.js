// @ts-check
import baseConfig from '../../eslint.config.base.js';

export default [
  ...baseConfig,
  {
    ignores: ['.next/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'],
  },
];
