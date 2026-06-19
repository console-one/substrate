/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  testTimeout: 30000,
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.[jt]s$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ES2022',
        target: 'ES2022',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        moduleResolution: 'bundler',
        types: ['jest', 'node'],
      },
    }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@console-one/sequence$': '<rootDir>/../../node_modules/@console-one/sequence/dist/src/index.js',
    '^@console-one/sequenceutils/transport$': '<rootDir>/../../node_modules/@console-one/sequenceutils/dist/transport/index.js',
    '^@console-one/sequenceutils/policies$': '<rootDir>/../../node_modules/@console-one/sequenceutils/dist/policies/index.js',
    '^@console-one/sequenceutils/tools$': '<rootDir>/../../node_modules/@console-one/sequenceutils/dist/tools/index.js',
    '^@console-one/sequenceutils/agent$': '<rootDir>/../../node_modules/@console-one/sequenceutils/dist/agent/index.js',
  },
};
