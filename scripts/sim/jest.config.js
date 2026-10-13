/* eslint-disable */
/** Unit tests for the driver simulator (scripts are outside the main jest projects). */
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/scripts/sim/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/scripts/sim/tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
