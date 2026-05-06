import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
    {
        ignores: ['dist/', 'node_modules/'],
    },
    js.configs.recommended,
    prettier,
    {
        files: ['astro.config.mjs', '*.js'],
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
    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        files: ['src/**/*.ts'],
    })),
    {
        files: ['src/**/*.ts'],
        languageOptions: { globals: globals.browser },
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
        },
    },
];
