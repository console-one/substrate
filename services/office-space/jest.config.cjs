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
    '^@console-one/sequence/v2$': '<rootDir>/../../node_modules/@console-one/sequence/dist/src-v2/index.js',
    '^@console-one/sequence$': '<rootDir>/../../node_modules/@console-one/sequence/dist/src/index.js',
  },
};
