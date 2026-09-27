/* eslint-disable */
const tsPreset = {
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },
};

/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  projects: [
    {
      ...tsPreset,
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...tsPreset,
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      setupFiles: ['<rootDir>/test/setup/integration.setup.ts'],
    },
    {
      ...tsPreset,
      displayName: 'e2e',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      setupFiles: ['<rootDir>/test/setup/e2e.setup.ts'],
    },
    {
      ...tsPreset,
      displayName: 'smoke',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/smoke/**/*.smoke-spec.ts'],
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.module.ts',
    '!src/**/index.ts', // barrels re-export only
    '!src/main.ts',
    '!src/worker.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  // TZ §21 — hard CI gates.
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
    'src/modules/hos/**/*.ts': { branches: 95, functions: 95, lines: 95, statements: 95 },
    'src/common/units/**/*.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
};
