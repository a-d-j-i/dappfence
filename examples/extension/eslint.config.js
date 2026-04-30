import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
    {
        ignores: ['dist/', 'node_modules/'],
    },
    js.configs.recommended,
    prettier,
    {
        files: ['build.js', 'icon.js', 'pack.js', 'test/server.js'],
        languageOptions: {
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
        },
    },
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
                chrome: 'readonly',
                SITE_CONFIG: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'no-console': 'off',
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
];
