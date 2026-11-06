module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { browser: true, es2022: true, node: true },
};
