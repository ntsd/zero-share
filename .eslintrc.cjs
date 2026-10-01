const parseGitignore = require('parse-gitignore');

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  plugins: ['svelte', '@typescript-eslint'],
  overrides: [
    {
      files: ['*.svelte'],
      parser: 'svelte-eslint-parser',
      parserOptions: {
        parser: '@typescript-eslint/parser'
      },
      rules: {
        'no-undef': 'off',
        // eslint core rules with known false positives in `.svelte` (per eslint-plugin-svelte base config)
        'no-inner-declarations': 'off',
        'no-self-assign': 'off'
      }
    },
    {
      files: ['*.d.ts'],
      rules: {
        '@typescript-eslint/triple-slash-reference': 'off'
      }
    }
  ],
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 2020
  },
  env: {
    browser: true,
    es2017: true,
    node: true
  },
  ignorePatterns: [
    '*.cjs',
    ...parseGitignore.parse('.gitignore').patterns // load pattern from .gitignore
  ]
};
